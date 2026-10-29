/**
 * @file tasks.ts
 * @project PipkerOps
 * @module tasks
 * @description 统一校验任务类型、目标权限、高危确认与幂等键，持久化执行意图和审计。
 * @logic Web/MCP/Cron 均使用本服务；不接受调用者指定幂等性；非幂等任务只有一次尝试。
 * @dependencies Prisma, Zod, authorization
 * @index_tags tasks, audit, execution
 * @author holic512
 */
import { z } from "zod";
import { db } from "../db";
import type { Prisma } from "@/generated/prisma/client";
import { authorize, ApiError, confirm, type Actor } from "../auth";
import { hashToken, canonicalJson } from "../crypto";
const text = z.string().min(1).max(4096);
const name = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:@/+-]+$/);
export const taskSpecs: Record<
  string,
  { scope: string; dangerous: boolean; idempotent: boolean; schema: z.ZodType }
> = {
  "system.info": {
    scope: "system:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({}),
  },
  "shell.exec": {
    scope: "system:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      script: text,
      timeoutSeconds: z.number().int().min(1).max(300).default(60),
    }),
  },
  "docker.list": {
    scope: "docker:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({}),
  },
  "docker.action": {
    scope: "docker:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      id: name,
      action: z.enum(["start", "stop", "restart", "remove"]),
    }),
  },
  "docker.logs": {
    scope: "docker:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({
      id: name,
      tail: z.number().int().min(1).max(2000).default(200),
    }),
  },
  "docker.pull": {
    scope: "docker:write",
    dangerous: false,
    idempotent: true,
    schema: z.object({ image: name }),
  },
  "compose.deploy": {
    scope: "docker:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
      yaml: z.string().min(1).max(262144),
    }),
  },
  "systemd.list": {
    scope: "system:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({}),
  },
  "systemd.action": {
    scope: "system:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      name: name,
      action: z.enum([
        "start",
        "stop",
        "restart",
        "reload",
        "enable",
        "disable",
      ]),
    }),
  },
  "files.list": {
    scope: "files:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({ path: text }),
  },
  "files.read": {
    scope: "files:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({ path: text }),
  },
  "files.write": {
    scope: "files:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({ path: text, content: z.string().max(262144) }),
  },
  "files.mkdir": {
    scope: "files:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({ path: text }),
  },
  "files.remove": {
    scope: "files:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({ path: text }),
  },
  "nginx.check": {
    scope: "sites:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({}),
  },
  "nginx.remove": {
    scope: "sites:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({ domain: name }),
  },
  "nginx.reload": {
    scope: "sites:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({}),
  },
  "nginx.apply": {
    scope: "sites:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({ domain: name, config: z.string().min(1).max(131072) }),
  },
  "firewall.list": {
    scope: "system:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({}),
  },
  "firewall.rule": {
    scope: "system:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      action: z.enum(["allow", "deny", "reject", "delete"]),
      ruleAction: z.enum(["allow", "deny", "reject"]).default("allow"),
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(["tcp", "udp"]),
    }),
  },
  "software.install": {
    scope: "system:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      name: z.enum([
        "nginx",
        "docker",
        "git",
        "curl",
        "htop",
        "certbot",
        "ufw",
        "wget",
        "unzip",
      ]),
    }),
  },
  "agent.upgrade": {
    scope: "nodes:approve",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      url: z.url().refine((u) => u.startsWith("https://")),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      restart: z.boolean().default(false),
    }),
  },
  "probe.run": {
    scope: "probes:write",
    dangerous: false,
    idempotent: true,
    schema: z.object({
      probeId: z.string(),
      type: z.enum(["HTTP", "TCP"]),
      target: text,
      timeoutMs: z.number().int().min(100).max(30000),
      config: z.record(z.string(), z.unknown()).default({}),
      mapping: z.record(z.string(), z.string()).default({}),
    }),
  },
};
const safeProject = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const domain = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/,
  );
Object.assign(taskSpecs, {
  "docker.stats": {
    scope: "docker:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({ id: name.optional() }),
  },
  "compose.read": {
    scope: "docker:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({ project: safeProject }),
  },
  "compose.status": {
    scope: "docker:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({ project: safeProject }),
  },
  "compose.list": {
    scope: "docker:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({}),
  },
  "nginx.certificate": {
    scope: "sites:read",
    dangerous: false,
    idempotent: true,
    schema: z.object({ domain, staging: z.boolean().default(false) }),
  },
  "nginx.acme": {
    scope: "sites:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      domain,
      email: z.email().max(200),
      staging: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(30).max(1800).default(600),
    }),
  },
  "nginx.renew": {
    scope: "sites:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      domain: domain.optional(),
      staging: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(30).max(1800).default(900),
    }),
  },
  "http.request": {
    scope: "actions:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      url: z.url().refine((v) => v.startsWith("https://")),
      method: z
        .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
        .default("GET"),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().max(131072).optional(),
      timeoutMs: z.number().int().min(100).max(30000).default(5000),
      mapping: z.record(z.string(), z.string()).default({}),
    }),
  },
});
export const taskInput = z.object({
  type: z.string(),
  nodeId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  confirmed: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export async function validateTask(
  actor: Actor,
  input: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const client = transaction ?? db();
  const data = taskInput.parse(input);
  if (!Object.hasOwn(taskSpecs, data.type))
    throw new ApiError(400, "不支持的任务类型");
  const spec = taskSpecs[data.type];
  authorize(actor, spec.scope, data.nodeId, spec.dangerous);
  if (spec.dangerous) confirm(data.confirmed);
  let payload = spec.schema.parse(data.payload) as Record<string, unknown>;
  if (data.type === "probe.run") {
    const probe = await client.probe.findUnique({
      where: { id: String(payload.probeId) },
    });
    if (!probe) throw new ApiError(404, "探针不存在");
    authorize(actor, "probes:write", probe.sourceNodeId ?? undefined);
    if ((data.nodeId ?? null) !== probe.sourceNodeId)
      throw new ApiError(403, "探针执行来源与配置不匹配");
    const mutating =
      probe.type === "HTTP" &&
      !["GET", "HEAD", "OPTIONS"].includes(
        String((probe.config as Record<string, unknown>).method ?? "GET"),
      );
    if (mutating) {
      authorize(actor, "probes:write", probe.sourceNodeId ?? undefined, true);
      confirm(data.confirmed);
    }
    payload = {
      probeId: probe.id,
      type: probe.type,
      target: probe.target,
      timeoutMs: probe.timeoutMs,
      config: probe.config,
      mapping: probe.mapping,
    };
  }
  if (!["probe.run", "http.request"].includes(data.type) && !data.nodeId)
    throw new ApiError(400, "请选择执行节点");
  if (data.type === "http.request" && data.nodeId)
    throw new ApiError(400, "HTTP动作由主控执行，节点来源请使用探针");
  if (data.nodeId) {
    const node = await client.node.findUnique({ where: { id: data.nodeId } });
    if (!node || node.status !== "APPROVED")
      throw new ApiError(409, "节点尚未批准或已吊销");
    if (
      data.type === "agent.upgrade" &&
      payload.restart &&
      (await client.task.count({
        where: {
          nodeId: data.nodeId,
          status: { in: ["DISPATCHED", "RUNNING"] },
        },
      }))
    )
      throw new ApiError(409, "升级并重启前请等待此节点正在执行的任务结束");
  }
  const idempotent =
    spec.idempotent &&
    (data.type !== "probe.run" ||
      ["GET", "HEAD", "OPTIONS"].includes(
        String(
          (payload.config as Record<string, unknown>)?.method ?? "GET",
        ).toUpperCase(),
      ) ||
      payload.type === "TCP");
  return { data, payload, idempotent, spec };
}
export async function createTask(
  actor: Actor,
  input: unknown,
  source: "WEB" | "MCP" | "CRON" | "SYSTEM" = "WEB",
  transaction?: Prisma.TransactionClient,
) {
  const client = transaction ?? db();
  const { data, payload, idempotent, spec } = await validateTask(
    actor,
    input,
    transaction,
  );
  const key = data.idempotencyKey
    ? hashToken(
        `${actor.userId}:${actor.apiKeyId ?? "web"}:${data.idempotencyKey}`,
      )
    : undefined;
  if (key) {
    const existing = await client.task.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing) {
      if (
        existing.type !== data.type ||
        existing.nodeId !== (data.nodeId ?? null) ||
        canonicalJson(existing.payload) !== canonicalJson(payload)
      )
        throw new ApiError(409, "幂等键已用于不同请求");
      return existing;
    }
  }
  const persist = async (tx: Prisma.TransactionClient) => {
    const task = await tx.task.create({
      data: {
        type: data.type,
        nodeId: data.nodeId,
        payload: payload as never,
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        source,
        idempotencyKey: key,
        idempotent,
        maxAttempts: idempotent ? 3 : 1,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        action: "tasks.create",
        resourceType: "Task",
        resourceId: task.id,
        nodeId: data.nodeId,
        detail: { type: data.type, source, dangerous: spec.dangerous },
      },
    });
    return task;
  };
  if (transaction) return persist(transaction);
  try {
    return await db().$transaction(persist);
  } catch (error) {
    if (key && (error as { code?: string }).code === "P2002") {
      const existing = await client.task.findUnique({
        where: { idempotencyKey: key },
      });
      if (
        existing &&
        existing.type === data.type &&
        existing.nodeId === (data.nodeId ?? null) &&
        canonicalJson(existing.payload) === canonicalJson(payload)
      )
        return existing;
    }
    throw error;
  }
}
export async function listTasks(actor: Actor) {
  authorize(actor, "tasks:read");
  const where =
    actor.apiKeyId && !actor.nodeIds?.includes("*")
      ? {
          OR: [
            { nodeId: { in: actor.nodeIds ?? [] } },
            { nodeId: null, apiKeyId: actor.apiKeyId },
          ],
        }
      : {};
  return db().task.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { node: { select: { id: true, name: true } } },
  });
}
export async function getTask(actor: Actor, id: string) {
  authorize(actor, "tasks:read");
  const task = await db().task.findUnique({
    where: { id },
    include: { logs: { orderBy: { sequence: "asc" }, take: 3000 } },
  });
  if (!task) throw new ApiError(404, "任务不存在");
  if (task.nodeId) authorize(actor, "tasks:read", task.nodeId);
  else if (actor.apiKeyId && task.apiKeyId !== actor.apiKeyId)
    throw new ApiError(403, "无权查看任务");
  return task;
}
