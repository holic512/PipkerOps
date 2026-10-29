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
    schema: z.object({ project: name, yaml: z.string().min(1).max(262144) }),
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
      action: z.enum(["start", "stop", "restart", "enable", "disable"]),
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
      action: z.enum(["allow", "deny", "delete"]),
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(["tcp", "udp"]),
    }),
  },
  "software.install": {
    scope: "system:write",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      name: z.enum(["nginx", "docker", "git", "curl", "htop"]),
    }),
  },
  "agent.upgrade": {
    scope: "nodes:approve",
    dangerous: true,
    idempotent: false,
    schema: z.object({
      url: z.url().refine((u) => u.startsWith("https://")),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
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
export const taskInput = z.object({
  type: z.string(),
  nodeId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  confirmed: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export async function createTask(
  actor: Actor,
  input: unknown,
  source: "WEB" | "MCP" | "CRON" | "SYSTEM" = "WEB",
  transaction?: Prisma.TransactionClient,
) {
  const client = transaction ?? db();
  const data = taskInput.parse(input);
  const spec = taskSpecs[data.type];
  if (!spec) throw new ApiError(400, "不支持的任务类型");
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
    payload = {
      probeId: probe.id,
      type: probe.type,
      target: probe.target,
      timeoutMs: probe.timeoutMs,
      config: probe.config,
      mapping: probe.mapping,
    };
  }
  if (data.type !== "probe.run" && !data.nodeId)
    throw new ApiError(400, "请选择执行节点");
  if (data.nodeId) {
    const node = await client.node.findUnique({ where: { id: data.nodeId } });
    if (!node || node.status !== "APPROVED")
      throw new ApiError(409, "节点尚未批准或已吊销");
  }
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
        idempotent: spec.idempotent,
        maxAttempts: spec.idempotent ? 3 : 1,
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
