/**
 * @file platform.ts
 * @project PipkerOps
 * @module business-api
 * @description Web 与 MCP 共用的资源服务入口，显式路由业务方法与输入契约。
 * @logic 查询执行 scope/节点过滤，写入验证后审计，实际远端操作转换为持久化任务。
 * @dependencies Prisma, authorization, node/task services, cron-parser
 * @index_tags api, apps, probes, topology, automation
 * @author holic512
 */
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db";
import { ApiError, authorize, confirm, nodeFilter, type Actor } from "../auth";
import { randomToken, hashToken } from "../crypto";
import * as nodes from "./nodes";
import { createTask, listTasks, getTask, taskSpecs } from "./tasks";
import { redis } from "../redis";
const label = z.string().trim().min(1).max(120);
const id = z.string().min(1).max(100);
const object = z.record(z.string(), z.unknown());
export const METHODS = [
  "overview",
  "nodes.list",
  "nodes.token",
  "nodes.approve",
  "nodes.reject",
  "nodes.revoke",
  "nodes.metrics",
  "applications.list",
  "applications.save",
  "applications.delete",
  "deployments.save",
  "dependencies.save",
  "probes.list",
  "probes.save",
  "probes.run",
  "probes.history",
  "probes.delete",
  "topology",
  "tasks.list",
  "tasks.get",
  "tasks.create",
  "tasks.cancel",
  "sites.list",
  "sites.save",
  "sites.apply",
  "actions.list",
  "actions.save",
  "actions.run",
  "schedules.list",
  "schedules.save",
  "schedules.delete",
  "alerts.list",
  "alerts.save",
  "notifications.list",
  "notifications.read",
  "keys.list",
  "keys.create",
  "keys.revoke",
  "audit.list",
  "terminal.ticket",
  "users.me",
] as const;
export type Method = (typeof METHODS)[number];
export const mutation = (method: string) =>
  !["overview", "topology"].includes(method) &&
  !method.endsWith(".list") &&
  !method.endsWith(".get") &&
  !method.endsWith(".history") &&
  !method.endsWith(".metrics") &&
  method !== "users.me";
function nodeWhere(actor: Actor) {
  return actor.apiKeyId && !actor.nodeIds?.includes("*")
    ? { nodeId: { in: actor.nodeIds ?? [] } }
    : {};
}
async function audit(
  actor: Actor,
  action: string,
  type: string,
  resourceId: string,
) {
  await db().auditEvent.create({
    data: {
      actorId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action,
      resourceType: type,
      resourceId,
    },
  });
}
const probeSchema = z.object({
  id: id.optional(),
  name: label,
  type: z.enum(["HTTP", "TCP"]),
  target: z.string().min(1).max(2048),
  sourceNodeId: id.nullable().optional(),
  applicationId: id.nullable().optional(),
  intervalSeconds: z.number().int().min(10).max(86400).default(60),
  timeoutMs: z.number().int().min(100).max(30000).default(5000),
  failureThreshold: z.number().int().min(1).max(100).default(3),
  enabled: z.boolean().default(true),
  config: object.default({}),
  mapping: z.record(z.string(), z.string()).default({}),
});
export function validateProbeTarget(type: string, target: string) {
  if (type === "HTTP") {
    const url = new URL(target);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      ["169.254.169.254", "metadata.google.internal"].includes(url.hostname)
    )
      throw new ApiError(400, "无效的 HTTP 探测地址");
  } else if (
    !/^([a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(target) ||
    Number(target.slice(target.lastIndexOf(":") + 1)) > 65535
  )
    throw new ApiError(400, "TCP 目标格式必须为 host:port");
}
export async function execute(
  actor: Actor,
  method: string,
  input: unknown = {},
): Promise<unknown> {
  const p = z.record(z.string(), z.unknown()).parse(input);
  switch (method) {
    case "users.me":
      return db().user.findUnique({
        where: { id: actor.userId },
        select: { id: true, email: true, displayName: true, role: true },
      });
    case "nodes.list":
      return nodes.listNodes(actor);
    case "nodes.token":
      return nodes.enrollmentToken(actor, p);
    case "nodes.approve":
    case "nodes.reject":
    case "nodes.revoke":
      confirm(p.confirmed);
      return nodes.changeNode(actor, id.parse(p.id), method.split(".")[1]);
    case "nodes.metrics":
      return nodes.metrics(
        actor,
        id.parse(p.nodeId),
        p.hours ? z.number().parse(p.hours) : 24,
      );
    case "tasks.create":
      return createTask(actor, p, actor.apiKeyId ? "MCP" : "WEB");
    case "tasks.list":
      return listTasks(actor);
    case "tasks.get":
      return getTask(actor, id.parse(p.id));
    case "tasks.cancel": {
      const t = await getTask(actor, id.parse(p.id));
      authorize(actor, "tasks:write", t.nodeId ?? undefined);
      confirm(p.confirmed);
      const changed = await db().task.updateMany({
        where: { id: t.id, status: "QUEUED" },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
      if (!changed.count) throw new ApiError(409, "只能取消尚未分发的任务");
      await audit(actor, method, "Task", t.id);
      return { id: t.id, status: "CANCELLED" };
    }
    case "overview": {
      authorize(actor, "nodes:read");
      const where = nodeFilter(actor);
      const [total, approved, pending, recent, taskCounts] = await Promise.all([
        db().node.count({ where }),
        db().node.count({
          where: {
            ...where,
            status: "APPROVED",
            lastSeenAt: { gte: new Date(Date.now() - 60000) },
          },
        }),
        db().node.count({ where: { ...where, status: "PENDING" } }),
        db().node.findMany({
          where,
          omit: {
            csrPem: true,
            certificatePem: true,
            certificateFingerprint: true,
          },
          include: { metrics: { take: 1, orderBy: { recordedAt: "desc" } } },
          take: 50,
          orderBy: { createdAt: "desc" },
        }),
        db().task.groupBy({
          by: ["status"],
          where: nodeWhere(actor),
          _count: true,
        }),
      ]);
      return {
        total,
        online: approved,
        pending,
        offline: total - approved - pending,
        nodes: recent.map((n) => ({
          ...n,
          connected:
            n.status === "APPROVED" &&
            !!n.lastSeenAt &&
            Date.now() - n.lastSeenAt.getTime() < 60000,
        })),
        tasks: taskCounts,
        generatedAt: new Date(),
      };
    }
    case "applications.list":
      authorize(actor, "apps:read");
      return db().application.findMany({
        include: {
          deployments: {
            where: nodeWhere(actor),
            include: {
              node: { select: { id: true, name: true, lastSeenAt: true } },
            },
          },
          probes: { select: { id: true, name: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    case "applications.save": {
      authorize(actor, "apps:write");
      const data = z
        .object({
          id: id.optional(),
          name: label,
          description: z.string().max(2000).optional(),
          labels: z.array(label).max(20).default([]),
          businessData: object.default({}),
        })
        .parse(p);
      const { id: appId, ...fields } = data;
      const app = appId
        ? await db().application.update({
            where: { id: appId },
            data: fields as never,
          })
        : await db().application.create({ data: fields as never });
      await audit(actor, method, "Application", app.id);
      return app;
    }
    case "applications.delete": {
      authorize(actor, "apps:write", undefined, true);
      confirm(p.confirmed);
      const appId = id.parse(p.id);
      await db().application.delete({ where: { id: appId } });
      await audit(actor, method, "Application", appId);
      return { id: appId };
    }
    case "deployments.save": {
      const d = z
        .object({
          id: id.optional(),
          applicationId: id,
          nodeId: id,
          name: label,
          type: z.enum([
            "docker",
            "compose",
            "systemd",
            "process",
            "database",
            "nginx",
          ]),
          target: z.string().min(1).max(500),
          healthUrl: z.url().optional(),
          metadata: object.default({}),
        })
        .parse(p);
      authorize(actor, "apps:write", d.nodeId);
      if (d.id) {
        const old = await db().deployment.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "部署不存在");
        authorize(actor, "apps:write", old.nodeId);
      }
      const { id: deploymentId, ...data } = d;
      const deployment = deploymentId
        ? await db().deployment.update({
            where: { id: deploymentId },
            data: data as never,
          })
        : await db().deployment.create({ data: data as never });
      await audit(actor, method, "Deployment", deployment.id);
      return deployment;
    }
    case "dependencies.save": {
      authorize(actor, "apps:write");
      const d = z
        .object({
          fromApplicationId: id,
          toApplicationId: id,
          type: label.default("depends_on"),
          description: z.string().max(500).optional(),
        })
        .parse(p);
      if (d.fromApplicationId === d.toApplicationId)
        throw new ApiError(400, "应用不能依赖自身");
      const result = await db().dependency.upsert({
        where: {
          fromApplicationId_toApplicationId_type: {
            fromApplicationId: d.fromApplicationId,
            toApplicationId: d.toApplicationId,
            type: d.type,
          },
        },
        create: d,
        update: { description: d.description },
      });
      await audit(actor, method, "Dependency", result.id);
      return result;
    }
    case "probes.list": {
      authorize(actor, "probes:read");
      return db().probe.findMany({
        where:
          actor.apiKeyId && !actor.nodeIds?.includes("*")
            ? {
                OR: [
                  { sourceNodeId: null },
                  { sourceNodeId: { in: actor.nodeIds ?? [] } },
                ],
              }
            : {},
        include: {
          sourceNode: { select: { id: true, name: true } },
          results: { take: 1, orderBy: { recordedAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      });
    }
    case "probes.save": {
      const d = probeSchema.parse(p);
      authorize(actor, "probes:write", d.sourceNodeId ?? undefined);
      validateProbeTarget(d.type, d.target);
      if (d.id) {
        const old = await db().probe.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "探针不存在");
        authorize(actor, "probes:write", old.sourceNodeId ?? undefined);
      }
      const { id: probeId, ...data } = d;
      const result = probeId
        ? await db().probe.update({
            where: { id: probeId },
            data: { ...data, nextRunAt: new Date() } as never,
          })
        : await db().probe.create({
            data: { ...data, nextRunAt: new Date() } as never,
          });
      await audit(actor, method, "Probe", result.id);
      return result;
    }
    case "probes.run": {
      const probe = await db().probe.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!probe) throw new ApiError(404, "探针不存在");
      return createTask(
        actor,
        {
          type: "probe.run",
          nodeId: probe.sourceNodeId ?? undefined,
          payload: {
            probeId: probe.id,
            type: probe.type,
            target: probe.target,
            timeoutMs: probe.timeoutMs,
            config: probe.config,
            mapping: probe.mapping,
          },
        },
        actor.apiKeyId ? "MCP" : "WEB",
      );
    }
    case "probes.history": {
      authorize(actor, "probes:read");
      const probe = await db().probe.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!probe) throw new ApiError(404, "探针不存在");
      authorize(actor, "probes:read", probe.sourceNodeId ?? undefined);
      const results = await db().probeResult.findMany({
        where: { probeId: probe.id },
        orderBy: { recordedAt: "desc" },
        take: 500,
      });
      return {
        results,
        successRate: results.length
          ? results.filter((r) => r.success).length / results.length
          : null,
        averageLatencyMs: results.length
          ? results.reduce((s, r) => s + r.latencyMs, 0) / results.length
          : null,
      };
    }
    case "probes.delete": {
      confirm(p.confirmed);
      const probe = await db().probe.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!probe) throw new ApiError(404, "探针不存在");
      authorize(actor, "probes:write", probe.sourceNodeId ?? undefined);
      await db().probe.delete({ where: { id: probe.id } });
      await audit(actor, method, "Probe", probe.id);
      return { id: probe.id };
    }
    case "topology": {
      authorize(actor, "apps:read");
      authorize(actor, "nodes:read");
      const [applications, nodeList, dependencies, probes, sites] =
        await Promise.all([
          db().application.findMany({
            include: { deployments: { where: nodeWhere(actor) } },
          }),
          nodes.listNodes(actor),
          db().dependency.findMany(),
          db().probe.findMany({
            where:
              actor.apiKeyId && !actor.nodeIds?.includes("*")
                ? {
                    OR: [
                      { sourceNodeId: null },
                      { sourceNodeId: { in: actor.nodeIds ?? [] } },
                    ],
                  }
                : {},
          }),
          db().site.findMany({ where: nodeWhere(actor) }),
        ]);
      return { applications, nodes: nodeList, dependencies, probes, sites };
    }
    case "sites.list":
      authorize(actor, "sites:read");
      return db().site.findMany({
        where: nodeWhere(actor),
        include: { node: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      });
    case "sites.save": {
      const d = z
        .object({
          id: id.optional(),
          name: label,
          nodeId: id,
          domain: z
            .string()
            .regex(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
          upstream: z.url(),
          config: z.string().max(131072).default(""),
        })
        .parse(p);
      authorize(actor, "sites:write", d.nodeId);
      if (d.id) {
        const old = await db().site.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "站点不存在");
        authorize(actor, "sites:write", old.nodeId);
      }
      const { id: siteId, ...fields } = d;
      const url = new URL(d.upstream);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new ApiError(400, "上游必须是 HTTP/HTTPS");
      const data = {
        ...fields,
        config:
          fields.config ||
          `server {\n    listen 80;\n    server_name ${d.domain};\n    location / {\n        proxy_pass ${url.href};\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}\n`,
        status: "DRAFT",
      };
      const site = siteId
        ? await db().site.update({ where: { id: siteId }, data })
        : await db().site.create({ data });
      await audit(actor, method, "Site", site.id);
      return site;
    }
    case "sites.apply": {
      const site = await db().site.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!site) throw new ApiError(404, "站点不存在");
      const task = await createTask(actor, {
        type: "nginx.apply",
        nodeId: site.nodeId,
        payload: { domain: site.domain, config: site.config },
        confirmed: p.confirmed,
      });
      return task;
    }
    case "keys.list":
      authorize(actor, "keys:write");
      return db().apiKey.findMany({
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          nodeIds: true,
          allowDangerous: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
    case "keys.create": {
      authorize(actor, "keys:write", undefined, true);
      confirm(p.confirmed);
      if (actor.apiKeyId) throw new ApiError(403, "API Key 不能创建新的密钥");
      const d = z
        .object({
          name: label,
          scopes: z.array(z.string().max(80)).min(1).max(50),
          nodeIds: z.array(id).max(100).default([]),
          allowDangerous: z.boolean().default(false),
          days: z.number().int().min(1).max(365).default(30),
        })
        .parse(p);
      const token = "pko_" + randomToken();
      const key = await db().apiKey.create({
        data: {
          name: d.name,
          scopes: d.scopes,
          nodeIds: d.nodeIds,
          allowDangerous: d.allowDangerous,
          expiresAt: new Date(Date.now() + d.days * 86400000),
          userId: actor.userId,
          keyHash: hashToken(token),
          keyPrefix: token.slice(0, 12),
        },
      });
      await audit(actor, method, "ApiKey", key.id);
      return { id: key.id, key: token };
    }
    case "keys.revoke": {
      authorize(actor, "keys:write");
      confirm(p.confirmed);
      const key = await db().apiKey.update({
        where: { id: id.parse(p.id) },
        data: { revokedAt: new Date() },
      });
      await audit(actor, method, "ApiKey", key.id);
      return { id: key.id };
    }
    case "audit.list":
      authorize(actor, "admin:write");
      return db().auditEvent.findMany({
        take: 200,
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { displayName: true } } },
      });
    case "notifications.list":
      authorize(actor, "alerts:read");
      return db().notification.findMany({
        where: { OR: [{ userId: null }, { userId: actor.userId }] },
        take: 100,
        orderBy: { createdAt: "desc" },
      });
    case "notifications.read": {
      authorize(actor, "alerts:read");
      return db().notification.updateMany({
        where: {
          id: id.parse(p.id),
          OR: [{ userId: null }, { userId: actor.userId }],
        },
        data: { readAt: new Date() },
      });
    }
    case "alerts.list":
      authorize(actor, "alerts:read");
      return db().alertRule.findMany({
        where: nodeWhere(actor),
        orderBy: { createdAt: "desc" },
      });
    case "alerts.save": {
      const d = z
        .object({
          name: label,
          nodeId: id.optional(),
          probeId: id.optional(),
          metric: z.enum([
            "cpuPercent",
            "memoryPercent",
            "offline",
            "probeFailure",
          ]),
          operator: z.enum(["gt", "lt"]).default("gt"),
          threshold: z.number().finite(),
          durationSeconds: z.number().int().min(0).max(86400).default(60),
          webhookUrl: z
            .url()
            .refine((v) => v.startsWith("https://"))
            .optional(),
        })
        .parse(p);
      authorize(actor, "alerts:write", d.nodeId);
      if (!d.nodeId && !d.probeId) throw new ApiError(400, "请选择节点或探针");
      if (d.probeId) {
        const probe = await db().probe.findUnique({ where: { id: d.probeId } });
        if (!probe) throw new ApiError(404, "探针不存在");
        authorize(actor, "alerts:write", probe.sourceNodeId ?? undefined);
      }
      const rule = await db().alertRule.create({ data: d });
      await audit(actor, method, "AlertRule", rule.id);
      return rule;
    }
    case "schedules.list":
      authorize(actor, "schedules:read");
      return db().schedule.findMany({
        where: nodeWhere(actor),
        orderBy: { createdAt: "desc" },
      });
    case "schedules.save": {
      authorize(actor, "schedules:write");
      if (actor.apiKeyId)
        throw new ApiError(403, "定时执行授权暂需在管理端设置");
      const d = z
        .object({
          name: label,
          cron: z.string().max(100),
          timezone: z.string().max(80).default("Asia/Shanghai"),
          taskType: z.string(),
          nodeId: id.optional(),
          payload: object.default({}),
          confirmed: z.boolean().optional(),
        })
        .parse(p);
      const spec = taskSpecs[d.taskType];
      if (!spec) throw new ApiError(400, "未知任务类型");
      authorize(actor, spec.scope, d.nodeId, spec.dangerous);
      if (spec.dangerous) confirm(d.confirmed);
      spec.schema.parse(d.payload);
      let nextRunAt: Date;
      try {
        nextRunAt = CronExpressionParser.parse(d.cron, { tz: d.timezone })
          .next()
          .toDate();
      } catch {
        throw new ApiError(400, "Cron 表达式或时区无效");
      }
      const data = {
        name: d.name,
        cron: d.cron,
        timezone: d.timezone,
        taskType: d.taskType,
        nodeId: d.nodeId,
        payload: d.payload,
      };
      const s = await db().schedule.create({
        data: {
          ...data,
          payload: data.payload as never,
          nextRunAt,
          createdById: actor.userId,
        },
      });
      await audit(actor, method, "Schedule", s.id);
      return s;
    }
    case "schedules.delete": {
      authorize(actor, "schedules:write");
      confirm(p.confirmed);
      const s = await db().schedule.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!s) throw new ApiError(404, "计划不存在");
      authorize(actor, "schedules:write", s.nodeId ?? undefined);
      await db().schedule.delete({ where: { id: s.id } });
      await audit(actor, method, "Schedule", s.id);
      return { id: s.id };
    }
    case "actions.list":
      authorize(actor, "actions:read");
      return db().customAction.findMany({ orderBy: { createdAt: "desc" } });
    case "actions.save": {
      authorize(actor, "actions:write", undefined, true);
      confirm(p.confirmed);
      const d = z
        .object({
          name: label,
          type: z.enum(["shell.exec", "docker.action", "HTTP", "URL"]),
          description: z.string().max(1000).optional(),
          config: object,
          parameters: z
            .array(
              z.object({
                name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                label: label,
                required: z.boolean().default(true),
              }),
            )
            .max(20)
            .default([]),
          nodeIds: z.array(id).max(100).default([]),
        })
        .parse(p);
      for (const n of d.nodeIds) authorize(actor, "actions:write", n, true);
      const a = await db().customAction.create({
        data: {
          ...d,
          config: d.config as never,
          parameters: d.parameters,
          dangerous: d.type !== "URL",
          createdById: actor.userId,
        },
      });
      await audit(actor, method, "CustomAction", a.id);
      return a;
    }
    case "actions.run": {
      const a = await db().customAction.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!a) throw new ApiError(404, "动作不存在");
      const nodeId = p.nodeId ? id.parse(p.nodeId) : undefined;
      authorize(actor, "actions:write", nodeId, a.dangerous);
      if (a.dangerous) confirm(p.confirmed);
      if (a.nodeIds.length && (!nodeId || !a.nodeIds.includes(nodeId)))
        throw new ApiError(403, "动作不允许此节点");
      const values = z
        .record(z.string(), z.string().max(4000))
        .parse(p.values ?? {});
      const parameters = z
        .array(z.object({ name: z.string(), required: z.boolean() }))
        .parse(a.parameters);
      for (const field of parameters)
        if (field.required && !values[field.name])
          throw new ApiError(400, `缺少参数 ${field.name}`);
      const config = { ...(a.config as Record<string, unknown>) };
      for (const [key, value] of Object.entries(config))
        if (typeof value === "string")
          config[key] = value.replace(
            /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
            (_, n) => {
              if (!(n in values)) throw new ApiError(400, `缺少参数 ${n}`);
              return a.type === "shell.exec"
                ? "'" + values[n].replaceAll("'", "'\\''") + "'"
                : values[n];
            },
          );
      if (a.type === "URL") {
        const url = z.url().parse(config.url);
        if (!url.startsWith("https://"))
          throw new ApiError(400, "跳转地址必须是 HTTPS");
        await audit(actor, method, "CustomAction", a.id);
        return { url };
      }
      if (a.type === "HTTP")
        throw new ApiError(400, "HTTP 自定义动作尚未开放，请使用探针");
      return createTask(actor, {
        type: a.type,
        nodeId,
        payload: config,
        confirmed: p.confirmed,
      });
    }
    case "terminal.ticket": {
      const nodeId = id.parse(p.nodeId);
      authorize(actor, "terminal:write", nodeId, true);
      confirm(p.confirmed);
      const node = await db().node.findUnique({ where: { id: nodeId } });
      if (!node || node.status !== "APPROVED")
        throw new ApiError(409, "节点不可用");
      const ticket = randomToken();
      await (
        await redis()
      ).set(
        `pko:terminal:${hashToken(ticket)}`,
        JSON.stringify({ actor, nodeId }),
        { EX: 60 },
      );
      await audit(actor, method, "Node", nodeId);
      const url = new URL(
        process.env.ENROLL_PUBLIC_URL ?? "https://localhost:9444",
      );
      url.protocol = "wss:";
      url.pathname = "/terminal";
      url.searchParams.set("ticket", ticket);
      return { url: url.href };
    }
    default:
      throw new ApiError(404, "未知业务方法");
  }
}
