/**
 * @file worker.ts
 * @project PipkerOps
 * @module background-worker
 * @description 持久化 Cron/多源探针调度、主控探针执行、租约恢复、告警及数据维护。
 * @logic PostgreSQL 行锁领取；非幂等失联仅 UNKNOWN；调度游标与任务同事务；Redis 只用于告警窗口。
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
import { hashToken } from "../lib/crypto";
let stopping = false;
let maintenanceDay = "";
async function schedules() {
  await db().$transaction(async (tx) => {
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
        const nextRunAt = CronExpressionParser.parse(s.cron, { tz: s.timezone })
          .next()
          .toDate();
        await createTask(
          { userId: s.createdBy.id, role: s.createdBy.role },
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
  });
}
async function probes() {
  await db().$transaction(async (tx) => {
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
      if (!active) {
        await tx.task.create({
          data: {
            id: randomUUID(),
            type: "probe.run",
            nodeId: p.sourceNodeId,
            source: "SYSTEM",
            idempotent: true,
            maxAttempts: 3,
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
  });
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
  >`UPDATE "Task" SET status='RUNNING', attempts=attempts+1, "startedAt"=now(), "leaseExpiresAt"=now()+interval '60 seconds',"updatedAt"=now() WHERE id IN (SELECT id FROM "Task" WHERE "nodeId" IS NULL AND type='probe.run' AND status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 8) RETURNING id,payload`;
  await Promise.allSettled(
    tasks.map(async (task) => {
      const result = await runProbe(task.payload as ProbeInput);
      await finishTask(task.id, null, {
        success: result.success,
        error: result.error,
        result,
        output: "",
      });
    }),
  );
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
  const day = new Date().toISOString().slice(0, 10);
  if (maintenanceDay !== day) {
    await db().$queryRaw`SELECT pipkerops_maintain_metrics()`;
    maintenanceDay = day;
  }
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
