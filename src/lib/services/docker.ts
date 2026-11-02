/**
 * @file docker.ts
 * @project PipkerOps
 * @module docker-direct-service
 * @description Web/MCP 共享的 Docker 直连、操作记录及 Agent 结果对账。
 * @logic 权限在入口校验；写请求只发送一次，重复请求查询原记录，Gateway 和快照按序号合并日志。
 * @dependencies Prisma, pinned Agent HTTPS, Docker contracts, authorization
 * @index_tags docker, compose, direct, audit, operation-log
 * @author holic512
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, authorize, confirm, type Actor } from "../auth";
import { agentDockerRequest, readCredential } from "../agent-connection";
import { canonicalJson, hashToken } from "../crypto";
import { db } from "../db";
import {
  dockerResultSchemas,
  dockerSnapshotSchema,
  dockerLogSchema,
  type DockerMethod,
} from "../docker-contracts";

const operationSelect = {
  id: true,
  method: true,
  nodeId: true,
  source: true,
  target: true,
  action: true,
  status: true,
  output: true,
  error: true,
  result: true,
  truncated: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} as const;
const active = ["REQUESTED", "RUNNING", "UNKNOWN"] as const;

export async function executeDocker(
  actor: Actor,
  method: DockerMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method === "docker.operations.list") {
    const nodeId = params.nodeId as string;
    authorize(actor, "docker:read", nodeId);
    return db().dockerOperation.findMany({
      where: { nodeId },
      select: {
        id: true,
        method: true,
        nodeId: true,
        source: true,
        target: true,
        action: true,
        status: true,
        truncated: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  if (method === "docker.operations.get")
    return getDockerOperation(actor, params.id as string);
  const { nodeId, idempotencyKey, confirmed, ...payload } = params;
  const writing = ["docker.action", "docker.pull", "compose.deploy"].includes(
    method,
  );
  const dangerous = method === "docker.action" || method === "compose.deploy";
  authorize(
    actor,
    writing ? "docker:write" : "docker:read",
    nodeId as string,
    dangerous,
  );
  if (dangerous) confirm(confirmed);
  const bundle = await dockerConnection(nodeId as string);
  if (!writing) {
    const raw = await agentDockerRequest(bundle, "/v1/docker/query", {
      method,
      params: payload,
    });
    return dockerResultSchemas[
      method as keyof typeof dockerResultSchemas
    ].parse(raw);
  }
  const requestHash = hashToken(
    canonicalJson({
      method,
      nodeId,
      payload,
      actorId: actor.userId,
      apiKeyId: actor.apiKeyId ?? null,
    }),
  );
  const candidateId = randomUUID();
  const operation = await db().$transaction(async (tx) => {
    const stored = await tx.dockerOperation.upsert({
      where: { idempotencyKey: idempotencyKey as string },
      update: {},
      create: {
        id: candidateId,
        method,
        nodeId: nodeId as string,
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        source: actor.apiKeyId ? "MCP" : "WEB",
        target: String(payload.id ?? payload.project ?? payload.image),
        action: method === "docker.action" ? (payload.action as string) : null,
        idempotencyKey: idempotencyKey as string,
        requestHash,
      },
    });
    if (stored.requestHash !== requestHash)
      throw new ApiError(409, "请求标识已用于其他 Docker 操作，请核对原请求");
    if (stored.id === candidateId)
      await tx.auditEvent.create({
        data: {
          actorId: actor.userId,
          apiKeyId: actor.apiKeyId,
          action: method,
          resourceType: "DockerOperation",
          resourceId: stored.id,
          nodeId: stored.nodeId,
          detail: { target: stored.target, action: stored.action },
        },
      });
    return stored;
  });
  // A repeated request only reconciles its original execution, never resends a command.
  if (operation.id !== candidateId)
    return reconcileOperation(operation.id, operation.nodeId);
  try {
    const snapshot = dockerSnapshotSchema.parse(
      await agentDockerRequest(bundle, "/v1/docker/operations", {
        id: operation.id,
        method,
        params: payload,
      }),
    );
    if (snapshot.id !== operation.id)
      throw new ApiError(502, "Agent 返回的操作身份不匹配");
    await storeDockerSnapshot(operation.nodeId, snapshot);
  } catch (error) {
    const rejected =
      error instanceof ApiError &&
      [400, 403, 404, 409, 422].includes(error.status);
    await db().$transaction(async (tx) => {
      const status = rejected ? "FAILED" : "UNKNOWN";
      const changed = await tx.dockerOperation.updateMany({
        where: { id: operation.id, status: "REQUESTED" },
        data: {
          status,
          finishedAt: rejected ? new Date() : null,
          error:
            error instanceof Error
              ? error.message
              : "未收到 Agent 明确反馈，请查询原操作和实际资源状态",
        },
      });
      if (changed.count)
        await tx.auditEvent.create({
          data: {
            actorId: actor.userId,
            apiKeyId: actor.apiKeyId,
            nodeId: operation.nodeId,
            action: `${method}.result`,
            resourceType: "DockerOperation",
            resourceId: operation.id,
            detail: {
              status,
              target: operation.target,
              action: operation.action,
            },
          },
        });
    });
  }
  return readOperation(operation.id);
}

export async function getDockerOperation(actor: Actor, id: string) {
  const operation = await db().dockerOperation.findUnique({
    where: { id },
    select: { nodeId: true },
  });
  if (!operation) throw new ApiError(404, "Docker 操作记录不存在");
  authorize(actor, "docker:read", operation.nodeId);
  return reconcileOperation(id, operation.nodeId);
}

async function reconcileOperation(id: string, nodeId: string) {
  const operation = await readOperation(id);
  if (!active.includes(operation.status as (typeof active)[number]))
    return operation;
  try {
    const snapshot = dockerSnapshotSchema.parse(
      await agentDockerRequest(
        await dockerConnection(nodeId),
        `/v1/docker/operations/${id}`,
      ),
    );
    if (snapshot.id !== id)
      throw new ApiError(502, "Agent 返回的操作身份不匹配");
    await storeDockerSnapshot(nodeId, snapshot);
    return readOperation(id);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      operation.status === "REQUESTED"
    ) {
      await db().dockerOperation.updateMany({
        where: { id, status: "REQUESTED" },
        data: {
          status: "UNKNOWN",
          error: "Agent 尚未确认原请求，请检查实际资源状态；不会重新发送操作",
        },
      });
      return readOperation(id);
    }
    return {
      ...operation,
      connectionError:
        error instanceof Error ? error.message : "暂时无法获取 Agent 操作进度",
    };
  }
}

function readOperation(id: string) {
  return db().dockerOperation.findUniqueOrThrow({
    where: { id },
    select: {
      ...operationSelect,
      logs: { orderBy: { sequence: "asc" } },
    },
  });
}

async function dockerConnection(nodeId: string) {
  const node = await db().node.findUnique({
    where: { id: nodeId },
    select: {
      status: true,
      agentUrl: true,
      agentCaPem: true,
      agentCredentialRef: true,
    },
  });
  if (!node || node.status !== "APPROVED")
    throw new ApiError(409, "节点不可用，请重新选择节点");
  if (!node.agentUrl || !node.agentCaPem || !node.agentCredentialRef)
    throw new ApiError(409, "节点缺少 Agent 接入信息");
  return {
    url: node.agentUrl,
    caPem: node.agentCaPem,
    accessKey: await readCredential(node.agentCredentialRef),
  };
}

export async function storeDockerSnapshot(
  nodeId: string,
  snapshot: z.infer<typeof dockerSnapshotSchema>,
) {
  return db().$transaction(async (tx) => {
    const stored = await tx.dockerOperation.findFirst({
      where: { id: snapshot.id, nodeId, method: snapshot.method },
    });
    if (!stored) return false;
    await tx.dockerOperationLog.createMany({
      data: snapshot.logs.map((entry) => ({
        ...entry,
        operationId: stored.id,
      })),
      skipDuplicates: true,
    });
    const changed = await tx.dockerOperation.updateMany({
      where: { id: stored.id, status: { in: [...active] } },
      data: {
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
        output: snapshot.output,
        error: snapshot.error || null,
        result: snapshot.result as never,
        truncated: snapshot.truncated,
      },
    });
    if (
      changed.count &&
      stored.status !== snapshot.status &&
      ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(snapshot.status)
    )
      await tx.auditEvent.create({
        data: {
          actorId: stored.actorId,
          apiKeyId: stored.apiKeyId,
          nodeId,
          action: `${stored.method}.result`,
          resourceType: "DockerOperation",
          resourceId: stored.id,
          detail: {
            status: snapshot.status,
            target: stored.target,
            action: stored.action,
          },
        },
      });
    return true;
  });
}

export async function storeDockerLog(
  nodeId: string,
  operationId: string,
  raw: unknown,
) {
  const entry = dockerLogSchema.parse(raw);
  const stored = await db().dockerOperation.findFirst({
    where: { id: operationId, nodeId },
    select: { id: true },
  });
  if (stored)
    await db().dockerOperationLog.upsert({
      where: {
        operationId_sequence: { operationId, sequence: entry.sequence },
      },
      create: { ...entry, operationId },
      update: {},
    });
}
