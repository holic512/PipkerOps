/**
 * @file worker.ts
 * @project PipkerOps
 * @module background-worker
 * @description 持久化 Cron/多源探针调度、主控探针执行、租约恢复、告警及数据维护。
 * @logic PostgreSQL行锁领取；非幂等失联仅UNKNOWN；调度游标、任务及计划关联同事务；Redis只用于告警窗口。
 * @dependencies Prisma, Redis, shared task/probe services, cron-parser
 * @index_tags worker, cron, probes, alerts, recovery
 * @author holic512
 */
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { db } from "../lib/db";
import { redis } from "../lib/redis";
import { runProbe, type ProbeInput } from "../lib/probe";
import { finishTask } from "../lib/services/results";
import { createTask } from "../lib/services/tasks";
import { authorize, refreshActor } from "../lib/auth";
import { hashToken } from "../lib/crypto";
let stopping = false;
let maintenanceNextAt = 0;
let maintenanceNoticeAt = 0;
let maintenanceJob: Promise<void> | undefined;
function maintainMetrics() {
  if (maintenanceJob || Date.now() < maintenanceNextAt) return;
  maintenanceJob = (async () => {
    try {
      const [row] = await db().$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '5min'`;
          return tx.$queryRaw<
            { summary: { skipped?: boolean; blockedPartitions?: string[] } }[]
          >`SELECT pipkerops_maintain_metrics() AS summary`;
        },
        { timeout: 310000, maxWait: 10000 },
      );
      const blocked = row?.summary.blockedPartitions ?? [];
      maintenanceNextAt = Date.now() + (blocked.length ? 1800000 : 21600000);
      if (blocked.length && Date.now() >= maintenanceNoticeAt) {
        await db().notification.create({
          data: {
            title: "指标分区需要检查",
            body: `${blocked.length} 个分区范围仍有DEFAULT记录，维护已保留这些数据。请检查数据时间和分区。`,
            level: "warning",
          },
        });
        maintenanceNoticeAt = Date.now() + 21600000;
      }
    } catch (error) {
      maintenanceNextAt = Date.now() + 300000;
      console.error("Metric maintenance failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
      if (Date.now() >= maintenanceNoticeAt) {
        try {
          await db().notification.create({
            data: {
              title: "指标维护未完成",
              body: "聚合和保留事务未提交，将在5分钟后重试。请检查数据库连接、锁和容量。",
              level: "error",
            },
          });
          maintenanceNoticeAt = Date.now() + 21600000;
        } catch {
          /* Database outage is already reported without leaking connection details. */
        }
      }
    }
  })().finally(() => {
    maintenanceJob = undefined;
  });
}
async function schedules() {
  await db().$transaction(
    async (tx) => {
      const due = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Schedule" WHERE enabled=true AND "nextRunAt"<=now() ORDER BY "nextRunAt" FOR UPDATE SKIP LOCKED LIMIT 20`;
      for (const row of due) {
        const s = await tx.schedule.findUnique({
          where: { id: row.id },
          include: { createdBy: true },
        });
        if (!s) continue;
        try {
          if (!s.createdBy) throw new Error("计划创建者已不存在");
          const nextRunAt = CronExpressionParser.parse(s.cron, {
            tz: s.timezone,
          })
            .next()
            .toDate();
          const actor = await refreshActor({
            userId: s.createdBy.id,
            role: s.createdBy.role,
            apiKeyId: s.createdByApiKeyId ?? undefined,
          });
          authorize(actor, "schedules:write", s.nodeId ?? undefined);
          const task = await createTask(
            actor,
            {
              type: s.taskType,
              nodeId: s.nodeId ?? undefined,
              payload: s.payload,
              confirmed: true,
              idempotencyKey: `cron:${s.id}:${s.nextRunAt?.toISOString()}`,
            },
            "CRON",
            tx,
          );
          await tx.task.update({
            where: { id: task.id },
            data: { scheduleId: s.id },
          });
          await tx.schedule.update({
            where: { id: s.id },
            data: { nextRunAt, lastRunAt: new Date() },
          });
        } catch {
          await tx.schedule.update({
            where: { id: s.id },
            data: { enabled: false },
          });
          await tx.notification.create({
            data: {
              userId: s.createdById,
              title: "定时计划已停用",
              body: `${s.name}：任务授权或配置无效，请检查后重新设置。`,
              level: "error",
            },
          });
        }
      }
    },
    { timeout: 30000, maxWait: 10000 },
  );
}
async function probes() {
  await db().$transaction(
    async (tx) => {
      const due = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Probe" WHERE enabled=true AND ("nextRunAt" IS NULL OR "nextRunAt"<=now()) ORDER BY "nextRunAt" FOR UPDATE SKIP LOCKED LIMIT 30`;
      for (const row of due) {
        const p = await tx.probe.findUnique({ where: { id: row.id } });
        if (!p) continue;
        const active = await tx.task.count({
          where: {
            type: "probe.run",
            status: { in: ["QUEUED", "DISPATCHED", "RUNNING"] },
            payload: { path: ["probeId"], equals: p.id },
          },
        });
        const idempotent =
          p.type === "TCP" ||
          ["GET", "HEAD", "OPTIONS"].includes(
            String(
              (p.config as Record<string, unknown>).method ?? "GET",
            ).toUpperCase(),
          );
        try {
          if (!p.createdById) throw new Error("探针缺少授权创建者");
          const actor = await refreshActor({
            userId: p.createdById,
            role: "VIEWER",
            apiKeyId: p.createdByApiKeyId ?? undefined,
          });
          authorize(
            actor,
            "probes:write",
            p.sourceNodeId ?? undefined,
            !idempotent,
          );
        } catch {
          await tx.probe.update({
            where: { id: p.id },
            data: { enabled: false, status: "UNKNOWN" },
          });
          await tx.notification.create({
            data: {
              userId: p.createdById,
              title: "探针已停用",
              body: `${p.name}：创建者授权已失效，请检查后重新保存。`,
              level: "warning",
            },
          });
          continue;
        }
        if (!active) {
          await tx.task.create({
            data: {
              id: randomUUID(),
              type: "probe.run",
              nodeId: p.sourceNodeId,
              source: "SYSTEM",
              actorId: p.createdById,
              apiKeyId: p.createdByApiKeyId,
              idempotent,
              maxAttempts: idempotent ? 3 : 1,
              payload: {
                probeId: p.id,
                type: p.type,
                target: p.target,
                timeoutMs: p.timeoutMs,
                config: p.config,
                mapping: p.mapping,
              },
            },
          });
        }
        await tx.probe.update({
          where: { id: p.id },
          data: { nextRunAt: new Date(Date.now() + p.intervalSeconds * 1000) },
        });
      }
    },
    { timeout: 30000, maxWait: 10000 },
  );
}
async function recover() {
  await db().task.updateMany({
    where: {
      status: { in: ["DISPATCHED", "RUNNING"] },
      leaseExpiresAt: { lt: new Date() },
      idempotent: false,
    },
    data: {
      status: "UNKNOWN",
      error: "执行租约过期，结果待 Agent 对账；非幂等任务不会自动重试",
      leaseExpiresAt: null,
    },
  });
  await db()
    .$executeRaw`UPDATE "Task" SET status=CASE WHEN attempts < "maxAttempts" THEN 'QUEUED'::"TaskStatus" ELSE 'UNKNOWN'::"TaskStatus" END, "leaseExpiresAt"=NULL, "updatedAt"=now(), error='执行租约过期' WHERE status IN ('DISPATCHED','RUNNING') AND "leaseExpiresAt" < now() AND idempotent=true`;
  await db().session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
async function control() {
  const tasks = await db().$queryRaw<
    Array<{ id: string; payload: unknown }>
  >`UPDATE "Task" SET status='RUNNING', attempts=attempts+1, "startedAt"=now(), "leaseExpiresAt"=now()+interval '60 seconds',"updatedAt"=now() WHERE id IN (SELECT id FROM "Task" WHERE "nodeId" IS NULL AND type IN ('probe.run','http.request') AND status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 8) RETURNING id,payload`;
  const completed = await Promise.allSettled(
    tasks.map(async (task) => {
      const stored = await db().task.findUniqueOrThrow({
        where: { id: task.id },
      });
      try {
        if (!stored.actorId) throw new Error("任务缺少授权创建者");
        const actor = await refreshActor({
          userId: stored.actorId,
          role: "VIEWER",
          apiKeyId: stored.apiKeyId ?? undefined,
        });
        authorize(
          actor,
          stored.type === "http.request" ? "actions:write" : "probes:write",
          undefined,
          stored.type === "http.request" || !stored.idempotent,
        );
      } catch {
        await db().task.update({
          where: { id: task.id },
          data: {
            status: "CANCELLED",
            error: "执行前权限已失效",
            finishedAt: new Date(),
            leaseExpiresAt: null,
          },
        });
        return;
      }
      const p = task.payload as Record<string, unknown>;
      const result = await runProbe(
        stored.type === "http.request"
          ? {
              probeId: task.id,
              type: "HTTP",
              target: String(p.url),
              timeoutMs: Number(p.timeoutMs),
              config: { method: p.method, headers: p.headers, body: p.body },
              mapping: p.mapping as Record<string, string>,
            }
          : (task.payload as ProbeInput),
      );
      await finishTask(task.id, null, {
        success: result.success,
        error: result.error,
        result,
        output: "",
      });
    }),
  );
  for (const [index, result] of completed.entries())
    if (result.status === "rejected")
      console.error("Control task execution failed", {
        taskId: tasks[index].id,
        name: result.reason instanceof Error ? result.reason.name : "unknown",
      });
}
async function alerts() {
  const client = await redis();
  const rules = await db().alertRule.findMany({
    where: { enabled: true },
    include: {
      node: {
        include: { metrics: { orderBy: { recordedAt: "desc" }, take: 1 } },
      },
      probe: true,
    },
  });
  for (const rule of rules) {
    let value: number | null = null;
    const node = rule.node;
    if (rule.metric === "offline" && node)
      value =
        node.status !== "APPROVED" ||
        !node.lastSeenAt ||
        Date.now() - node.lastSeenAt.getTime() > 60000
          ? 1
          : 0;
    else if (rule.metric === "cpuPercent" && node?.metrics[0])
      value = node.metrics[0].cpuPercent;
    else if (rule.metric === "memoryPercent" && node?.metrics[0])
      value = node.metrics[0].memoryPercent;
    else if (rule.metric === "probeFailure" && rule.probe)
      value = rule.probe.failureCount;
    const breached =
      value !== null &&
      (rule.operator === "lt"
        ? value < rule.threshold
        : value > rule.threshold);
    const key = `pko:alert:${rule.id}`;
    if (!breached) {
      await client.del(key + ":since");
      const fired = await client.getDel(key + ":fired");
      if (fired)
        await db().notification.create({
          data: {
            alertRuleId: rule.id,
            title: `${rule.name} 已恢复`,
            body: "指标已恢复到规则阈值范围。",
            level: "success",
          },
        });
      continue;
    }
    const since = await client.get(key + ":since");
    if (!since) {
      await client.set(key + ":since", String(Date.now()), { EX: 172800 });
      continue;
    }
    if (Date.now() - Number(since) < rule.durationSeconds * 1000) continue;
    if (!(await client.set(key + ":fired", "1", { NX: true, EX: 86400 })))
      continue;
    const message = {
      title: rule.name,
      body: `${rule.metric} = ${value}，阈值 ${rule.operator} ${rule.threshold}`,
      level: "error",
    };
    const notification = await db().notification.create({
      data: { alertRuleId: rule.id, ...message },
    });
    if (rule.webhookUrl) {
      try {
        const response = await fetch(rule.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...message, id: notification.id }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("webhook status");
        await response.body?.cancel();
      } catch {
        await db().auditEvent.create({
          data: {
            action: "alerts.webhook.failed",
            resourceType: "AlertRule",
            resourceId: rule.id,
            detail: {
              notificationId: notification.id,
              destinationHash: hashToken(rule.webhookUrl),
            },
          },
        });
      }
    }
  }
}
async function tick() {
  await recover();
  await schedules();
  await probes();
  await control();
  await alerts();
  maintainMetrics();
}
async function main() {
  console.log("Worker ready");
  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      console.error("Worker tick failed", {
        name: e instanceof Error ? e.name : "unknown",
      });
    }
    if (!stopping)
      await new Promise((r) =>
        setTimeout(r, Number(process.env.WORKER_INTERVAL_MS ?? 2000)),
      );
  }
  await maintenanceJob;
  await db().$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
void main();
