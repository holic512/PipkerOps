/**
 * @file gateway.ts
 * @project PipkerOps
 * @module agent-gateway
 * @description 主动连接 HTTPS Agent，任务分发、Docker 独立操作日志及同源 Web 终端转发。
 * @logic CA 与 Agent 身份校验；连接凭证变更即重连；任务与 Docker 操作分别入库后 ACK；终端票据一次性消费。
 * @dependencies HTTP, WebSocket, Prisma, Redis, agent transport
 * @index_tags gateway, agent, pty, metrics
 * @author holic512
 */
import { configValues, appOrigin } from "../lib/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { db } from "../lib/db";
import { redis } from "../lib/redis";
import { hashToken } from "../lib/crypto";
import { readCredential, testAgent, agentError } from "../lib/agent-connection";
import { finishTask } from "../lib/services/results";
import { authorize, requireHttps, refreshActor, type Actor } from "../lib/auth";
import { taskSpecs } from "../lib/services/tasks";
import { storeDockerLog, storeDockerSnapshot } from "../lib/services/docker";
import { dockerSnapshotSchema } from "../lib/docker-contracts";
const connections = new Map<string, WebSocket>();
const identifiedConnections = new WeakSet<WebSocket>();
const connectionCredentials = new WeakMap<WebSocket, string>();
const terminals = new Map<
  string,
  { socket: WebSocket; nodeId: string; actor: Actor; containerId?: string }
>();
const terminalWss = new WebSocketServer({
  noServer: true,
  maxPayload: 128 * 1024,
});
const enrollment = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(req.url === "/health" ? 200 : 404, {
    "Content-Type": "application/json",
  });
  res.end(
    JSON.stringify({ status: req.url === "/health" ? "ok" : "not found" }),
  );
});
let syncing = false;
let stopping = false;
async function connectNodes() {
  if (syncing || stopping) return;
  syncing = true;
  try {
    const nodes = await db().node.findMany({
      where: {
        status: "APPROVED",
        agentId: { not: null },
        agentUrl: { not: null },
        agentCredentialRef: { not: null },
      },
    });
    await Promise.allSettled(
      nodes
        .filter((node) => !connections.has(node.id))
        .map(async (node) => {
          try {
            const accessKey = await readCredential(node.agentCredentialRef!);
            const bundle = {
              url: node.agentUrl!,
              caPem: node.agentCaPem!,
              accessKey,
              agentId: node.agentId!,
              format: 1 as const,
              protocolVersion: 1 as const,
              deployRoot: node.deployRoot ?? "",
            };
            await testAgent(bundle);
            if (stopping) return;
            const url = new URL("/v1/connect", bundle.url);
            url.protocol = "wss:";
            const ws = new WebSocket(url, {
              ca: bundle.caPem,
              minVersion: "TLSv1.2",
              headers: { Authorization: `Bearer ${accessKey}` },
              handshakeTimeout: 10000,
              maxPayload: 2 * 1024 * 1024,
            });
            connections.set(node.id, ws);
            connectionCredentials.set(ws, node.agentCredentialRef!);
            let messages = Promise.resolve();
            let pending = 0;
            let identified = false;
            ws.on("message", (raw) => {
              if (++pending > 512) {
                ws.close(4008, "message rate exceeded");
                return;
              }
              messages = messages
                .then(async () => {
                  if (!identified) {
                    const hello = z
                      .object({
                        type: z.literal("connected"),
                        agentId: z.literal(node.agentId!),
                      })
                      .parse(JSON.parse(raw.toString()));
                    identified = !!hello;
                    identifiedConnections.add(ws);
                    await db().node.update({
                      where: { id: node.id },
                      data: { lastSeenAt: new Date(), connectionError: null },
                    });
                    return;
                  }
                  await receive(node.id, ws, raw.toString());
                })
                .catch(() => ws.close(4002, "invalid message"))
                .finally(() => {
                  pending--;
                });
            });
            ws.on("ping", () => {});
            ws.on("error", () => {
              void db()
                .node.update({
                  where: { id: node.id },
                  data: {
                    connectionError:
                      "Agent 连接中断，请检查地址、凭证和服务状态",
                  },
                })
                .catch(() => {});
            });
            ws.on("close", () => {
              if (connections.get(node.id) === ws) {
                connections.delete(node.id);
                void db()
                  .node.update({
                    where: { id: node.id },
                    data: { lastSeenAt: null },
                  })
                  .catch(() => {});
              }
              for (const [session, t] of terminals)
                if (t.nodeId === node.id) {
                  t.socket.close(4003, "agent disconnected");
                  terminals.delete(session);
                }
            });
          } catch (error) {
            await db().node.update({
              where: { id: node.id },
              data: {
                connectionError: agentError(error).message,
                lastSeenAt: null,
              },
            });
          }
        }),
    );
  } finally {
    syncing = false;
  }
}
enrollment.on("upgrade", async (req, socket, head) => {
  try {
    const request = new Request(
      `http://${req.headers.host ?? "gateway"}${req.url ?? "/"}`,
      {
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      },
    );
    requireHttps(request);
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/terminal/ws" ||
      req.headers.origin !== appOrigin(request)
    )
      throw new Error("origin");
    const ticket = url.searchParams.get("ticket");
    if (!ticket) throw new Error("ticket");
    const raw = await (
      await redis()
    ).getDel(`pko:terminal:${hashToken(ticket)}`);
    if (!raw) throw new Error("expired ticket");
    const ticketData = JSON.parse(raw) as {
      containerId?: string;
      actor: Actor;
      nodeId: string;
    };
    const nodeId = ticketData.nodeId;
    const actor = await refreshActor(ticketData.actor);
    authorize(actor, "terminal:write", nodeId, true);
    if (ticketData.containerId) authorize(actor, "docker:write", nodeId, true);
    const node = await db().node.findUnique({ where: { id: nodeId } });
    if (node?.status !== "APPROVED" || !connections.has(nodeId))
      throw new Error("offline");
    const sessionId = randomUUID();
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminals.set(sessionId, {
        socket: ws,
        nodeId,
        actor,
        containerId: ticketData.containerId,
      });
      ws.on("error", () => {});
      let size = 0;
      const limiter = setInterval(() => {
        size = 0;
      }, 1000);
      ws.on("message", (raw) => {
        size += raw.toString().length;
        if (size > 131072) {
          ws.close(4008, "input rate");
          return;
        }
        try {
          const p = z
            .discriminatedUnion("type", [
              z.object({
                type: z.literal("terminal.input"),
                data: z.string().max(32000),
              }),
              z.object({
                type: z.literal("terminal.resize"),
                cols: z.number().int().min(20).max(400),
                rows: z.number().int().min(5).max(200),
              }),
            ])
            .parse(JSON.parse(raw.toString()));
          connections.get(nodeId)?.send(JSON.stringify({ ...p, sessionId }));
        } catch {
          ws.close(4002, "invalid input");
        }
      });
      ws.on("close", () => {
        clearInterval(limiter);
        terminals.delete(sessionId);
        connections
          .get(nodeId)
          ?.send(JSON.stringify({ type: "terminal.close", sessionId }));
        void db()
          .auditEvent.create({
            data: {
              actorId: actor.userId,
              apiKeyId: actor.apiKeyId,
              action: "terminal.close",
              resourceType: "Node",
              resourceId: nodeId,
              nodeId,
            },
          })
          .catch(() => {});
      });
      connections.get(nodeId)?.send(
        JSON.stringify({
          type: "terminal.open",
          containerId: ticketData.containerId,
          sessionId,
          cols: 120,
          rows: 32,
        }),
      );
    });
  } catch {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});
const metrics = z
  .object({
    cpuPercent: z.number().finite().min(0).max(100),
    memoryPercent: z.number().finite().min(0).max(100),
  })
  .passthrough();
const lastMetrics = new Map<string, number>();
async function receive(id: string, ws: WebSocket, raw: string) {
  const p = z
    .object({ type: z.string(), taskId: z.string().optional() })
    .passthrough()
    .parse(JSON.parse(raw));
  const node = await db().node.findUnique({
    where: { id },
  });
  if (
    node?.status !== "APPROVED" ||
    connections.get(id) !== ws ||
    node.agentCredentialRef !== connectionCredentials.get(ws)
  ) {
    ws.close(4003, "revoked");
    return;
  }
  if (p.type === "heartbeat" || p.type === "metrics")
    await db().node.update({ where: { id }, data: { lastSeenAt: new Date() } });
  if (p.type === "metrics") {
    if (Date.now() - (lastMetrics.get(id) ?? 0) < 3000) return;
    const payload = metrics.parse(p.payload);
    lastMetrics.set(id, Date.now());
    await db().metricSample.create({
      data: {
        nodeId: id,
        cpuPercent: payload.cpuPercent,
        memoryPercent: payload.memoryPercent,
        payload: payload as never,
      },
    });
    const meta = z
      .object({
        hostname: z.string().max(255).optional(),
        os: z.string().max(80).optional(),
        arch: z.string().max(32).optional(),
        agentVersion: z.string().max(64).optional(),
      })
      .parse(payload);
    await db().node.update({ where: { id }, data: meta });
    const containers = payload.containers;
    if (Array.isArray(containers)) {
      for (const d of await db().deployment.findMany({
        where: { nodeId: id, type: "docker", healthUrl: null },
      })) {
        const container = containers.find(
          (c) =>
            typeof c === "object" &&
            c !== null &&
            ((c as Record<string, unknown>).id === d.target ||
              (c as Record<string, unknown>).name === d.target),
        );
        if (container) {
          const status = String(
            (container as Record<string, unknown>).state ??
              (container as Record<string, unknown>).status ??
              "UNKNOWN",
          );
          await db().deployment.update({
            where: { id: d.id },
            data: { status },
          });
        }
      }
    }
  }
  if (p.type === "task.busy" && p.taskId) {
    // Direct Docker requests share Agent capacity; a rejected legacy task has not begun.
    await db().task.updateMany({
      where: { id: p.taskId, nodeId: id, status: "DISPATCHED" },
      data: {
        status: "QUEUED",
        attempts: { decrement: 1 },
        dispatchedAt: null,
        leaseExpiresAt: null,
      },
    });
  }
  if (p.type === "task.started" && p.taskId) {
    const task = await db().task.findFirst({
      where: { id: p.taskId, nodeId: id, status: "DISPATCHED" },
    });
    if (task) {
      const payload = task.payload as Record<string, unknown>;
      const seconds = Math.min(
        3600,
        Math.max(
          ["ops.update", "deployment.update"].includes(task.type) ? 1800 : 600,
          Number(payload.timeoutSeconds ?? 0) + 60,
        ),
      );
      await db().task.updateMany({
        where: { id: task.id, status: "DISPATCHED" },
        data: {
          status: "RUNNING",
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + seconds * 1000),
        },
      });
    }
  }
  if (p.type === "docker.operation.log") {
    await storeDockerLog(id, z.string().uuid().parse(p.operationId), p);
  }
  if (
    p.type === "docker.operation.started" ||
    p.type === "docker.operation.result"
  ) {
    const snapshot = dockerSnapshotSchema.parse(p.payload);
    if (snapshot.id !== p.operationId)
      throw new Error("Docker operation identity mismatch");
    const stored = await storeDockerSnapshot(id, snapshot);
    if (
      stored &&
      p.type === "docker.operation.result" &&
      ws.readyState === WebSocket.OPEN
    )
      ws.send(
        JSON.stringify({
          type: "docker.operation.ack",
          operationId: snapshot.id,
        }),
      );
  }
  if (p.type === "task.log" && p.taskId) {
    const data = z
      .object({
        sequence: z.number().int().min(0),
        stream: z.string().max(20),
        message: z.string().max(32768),
      })
      .parse(p);
    const task = await db().task.findFirst({
      where: {
        id: p.taskId,
        nodeId: id,
        status: { in: ["DISPATCHED", "RUNNING", "UNKNOWN"] },
      },
    });
    if (task)
      await db().taskLog.upsert({
        where: {
          taskId_sequence: { taskId: p.taskId, sequence: data.sequence },
        },
        create: { taskId: p.taskId, ...data },
        update: {},
      });
  }
  if (p.type === "task.result" && p.taskId) {
    await finishTask(p.taskId, id, p);
    const stored = await db().task.findFirst({
      where: {
        id: p.taskId,
        nodeId: id,
        status: { in: ["SUCCEEDED", "FAILED", "UNKNOWN"] },
      },
    });
    if (stored && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "task.ack", taskId: p.taskId }));
  }
  if (
    p.type === "terminal.output" ||
    p.type === "terminal.exit" ||
    p.type === "terminal.error"
  ) {
    const session = terminals.get(String(p.sessionId));
    if (
      session?.nodeId === id &&
      session.socket.readyState === WebSocket.OPEN
    ) {
      session.socket.send(raw);
      if (p.type === "terminal.exit" || p.type === "terminal.error")
        session.socket.close(1000, "exited");
    }
  }
}
let running = false;
async function dispatch() {
  if (running) return;
  running = true;
  try {
    for (const [nodeId, ws] of connections) {
      const node = await db().node.findUnique({
        where: { id: nodeId },
      });
      if (
        node?.status !== "APPROVED" ||
        node.agentCredentialRef !== connectionCredentials.get(ws)
      ) {
        ws.close(4003, "revoked");
        continue;
      }
      if (ws.readyState !== WebSocket.OPEN || !identifiedConnections.has(ws))
        continue;
      const count = await db().task.count({
        where: { nodeId, status: { in: ["DISPATCHED", "RUNNING"] } },
      });
      if (count >= 4) continue;
      const upgrading = await db().task.count({
        where: {
          nodeId,
          type: { in: ["agent.upgrade", "deployment.update", "ops.update"] },
          status: { in: ["DISPATCHED", "RUNNING"] },
        },
      });
      if (upgrading) continue;
      const recentUpgrade = await db().task.findFirst({
        where: {
          nodeId,
          type: "agent.upgrade",
          status: "SUCCEEDED",
          finishedAt: { gt: new Date(Date.now() - 15000) },
        },
        orderBy: { finishedAt: "desc" },
      });
      if (
        recentUpgrade &&
        (recentUpgrade.payload as Record<string, unknown>).restart
      )
        continue;
      const tasks = await db().$queryRaw<
        Array<{ id: string; type: string; payload: unknown }>
      >`UPDATE "Task" SET status='DISPATCHED', attempts=attempts+1, "dispatchedAt"=now(), "leaseExpiresAt"=now()+interval '10 minutes', "updatedAt"=now() WHERE id IN (SELECT id FROM "Task" WHERE "nodeId"=${nodeId} AND status='QUEUED' AND attempts < "maxAttempts" ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT ${4 - count}) RETURNING id,type,payload`;
      let upgradeDispatched = false;
      for (const task of tasks) {
        const stored = await db().task.findUniqueOrThrow({
          where: { id: task.id },
        });
        if (
          upgradeDispatched ||
          (["agent.upgrade", "deployment.update", "ops.update"].includes(
            task.type,
          ) &&
            (count > 0 ||
              tasks.some(
                (t) =>
                  ![
                    "agent.upgrade",
                    "deployment.update",
                    "ops.update",
                  ].includes(t.type),
              )))
        ) {
          await db().task.updateMany({
            where: { id: task.id, status: "DISPATCHED" },
            data: {
              status: "QUEUED",
              attempts: { decrement: 1 },
              leaseExpiresAt: null,
              dispatchedAt: null,
            },
          });
          continue;
        }

        try {
          {
            if (!stored.actorId) throw new Error("missing actor");
            const actor = await refreshActor({
              userId: stored.actorId,
              role: "VIEWER",
              apiKeyId: stored.apiKeyId ?? undefined,
            });
            const spec = taskSpecs[task.type];
            if (!spec) throw new Error("unknown task");
            authorize(
              actor,
              spec.scope,
              nodeId,
              spec.dangerous ||
                (task.type === "probe.run" && !stored.idempotent),
            );
          }
        } catch {
          await db().$transaction(async (tx) => {
            await tx.task.updateMany({
              where: { id: task.id, status: "DISPATCHED" },
              data: {
                status: "CANCELLED",
                error: "执行前权限已失效",
                finishedAt: new Date(),
                leaseExpiresAt: null,
              },
            });
            await tx.auditEvent.create({
              data: {
                action: "tasks.authorization-expired",
                resourceType: "Task",
                resourceId: task.id,
                nodeId,
              },
            });
          });
          continue;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "task", task }));
          if (
            ["agent.upgrade", "deployment.update", "ops.update"].includes(
              task.type,
            )
          )
            upgradeDispatched = true;
        }
      }
    }
    for (const [sessionId, t] of terminals) {
      const node = await db().node.findUnique({
        where: { id: t.nodeId },
        select: { status: true },
      });
      let valid = node?.status === "APPROVED";
      try {
        const actor = await refreshActor(t.actor);
        authorize(actor, "terminal:write", t.nodeId, true);
        if (t.containerId) authorize(actor, "docker:write", t.nodeId, true);
      } catch {
        valid = false;
      }
      if (!valid) {
        t.socket.close(4003, "access revoked");
        connections
          .get(t.nodeId)
          ?.send(JSON.stringify({ type: "terminal.close", sessionId }));
      }
    }
  } catch (e) {
    console.error("Gateway dispatch failed", {
      name: e instanceof Error ? e.name : "unknown",
    });
  } finally {
    running = false;
  }
}
const timer = setInterval(() => void dispatch(), 1000);
const connector = setInterval(
  () =>
    void connectNodes().catch(() =>
      console.error("Agent connection scan failed"),
    ),
  5000,
);
void connectNodes().catch(() => console.error("Agent connection scan failed"));
enrollment.listen(Number(configValues.GATEWAY_PORT ?? 9444), "0.0.0.0", () =>
  console.log("Agent connector / terminal gateway ready"),
);
async function shutdown() {
  stopping = true;
  clearInterval(timer);
  clearInterval(connector);
  for (const ws of connections.values()) ws.terminate();
  for (const t of terminals.values()) t.socket.close(1001, "shutdown");
  await new Promise<void>((resolve) => enrollment.close(() => resolve()));
  await db().$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
