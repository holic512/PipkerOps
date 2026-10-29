/**
 * @file gateway.ts
 * @project PipkerOps
 * @module agent-gateway
 * @description TLS 注册审批入口、mTLS Agent 长连接、指标入库、任务分发和 Web PTY 转发。
 * @logic 证书链与节点指纹状态双重验证；任务先持久化分发状态再发送；终端票据一次性消费。
 * @dependencies HTTPS, WebSocket, Prisma, Redis, shared services
 * @index_tags gateway, agent, mtls, pty, metrics
 * @author holic512
 */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import type { TLSSocket } from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { db } from "../lib/db";
import { redis } from "../lib/redis";
import { hashToken } from "../lib/crypto";
import { pkiFiles } from "../lib/pki";
import {
  enroll,
  enrollmentStatus,
  renewCertificate,
  acceptsFingerprint,
} from "../lib/services/nodes";
import { finishTask } from "../lib/services/results";
import { ApiError, authorize, refreshActor, type Actor } from "../lib/auth";
import { taskSpecs } from "../lib/services/tasks";
import { appOrigin } from "../lib/config";
const files = pkiFiles();
const tls = {
  key: readFileSync(files.key),
  cert: readFileSync(files.cert),
  ca: readFileSync(files.ca),
  minVersion: "TLSv1.2" as const,
};
const connections = new Map<string, WebSocket>();
const connectionFingerprints = new WeakMap<WebSocket, string>();
const terminals = new Map<
  string,
  { socket: WebSocket; nodeId: string; actor: Actor; containerId?: string }
>();
const agentWss = new WebSocketServer({
  noServer: true,
  maxPayload: 2 * 1024 * 1024,
});
const terminalWss = new WebSocketServer({
  noServer: true,
  maxPayload: 128 * 1024,
});
const enrollment = createServer(tls, async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.url === "/health") {
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (
    req.method !== "POST" ||
    !["/enroll", "/enroll/status"].includes(req.url ?? "")
  ) {
    res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
    return;
  }
  try {
    // 全局及来源限流不记录原始 token，注册只能通过 TLS。
    const r = await redis();
    const key = `pko:enroll-limit:${hashToken(req.socket.remoteAddress ?? "unknown")}`;
    const attempts = await r.incr(key);
    if (attempts === 1) await r.expire(key, 60);
    if (attempts > 120) throw new ApiError(429, "注册请求过多");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 20000) throw new ApiError(413, "请求过大");
    }
    const data =
      req.url === "/enroll"
        ? await enroll(JSON.parse(raw))
        : await enrollmentStatus(JSON.parse(raw));
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(e instanceof ApiError ? e.status : 400).end(
      JSON.stringify({
        error: e instanceof ApiError ? e.message : "注册请求无效",
      }),
    );
  }
});
const agents = createServer(
  { ...tls, requestCert: true, rejectUnauthorized: true },
  (_, res) => res.writeHead(404).end(),
);
agents.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", "https://gateway");
    if (url.pathname !== "/agent") throw new Error("path");
    const id = url.searchParams.get("nodeId");
    if (!id) throw new Error("id");
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    if (!(req.socket as TLSSocket).authorized || !peer.raw)
      throw new Error("certificate");
    const node = await db().node.findUnique({ where: { id } });
    const fingerprint = createHash("sha256").update(peer.raw).digest("hex");
    if (
      !node ||
      node.status !== "APPROVED" ||
      !acceptsFingerprint(node, fingerprint) ||
      peer.subject.CN !== id
    )
      throw new Error("node");
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      connections.get(id)?.close(4001, "replaced");
      connections.set(id, ws);
      connectionFingerprints.set(ws, fingerprint);
      void db()
        .node.update({
          where: { id },
          data: { lastSeenAt: new Date(), ipAddress: req.socket.remoteAddress },
        })
        .catch(() => {});
      let messages = Promise.resolve();
      let pending = 0;
      ws.on("message", (raw) => {
        if (++pending > 512) {
          ws.close(4008, "message rate exceeded");
          return;
        }
        messages = messages
          .then(() => receive(id, ws, raw.toString()))
          .catch(() => {
            ws.close(4002, "invalid message");
          })
          .finally(() => {
            pending--;
          });
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (connections.get(id) === ws) connections.delete(id);
        for (const [session, t] of terminals)
          if (t.nodeId === id) {
            t.socket.close(4003, "agent disconnected");
            terminals.delete(session);
          }
      });
      ws.send(JSON.stringify({ type: "connected", nodeId: id }));
    });
  } catch {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});
enrollment.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", "https://gateway");
    if (url.pathname !== "/terminal" || req.headers.origin !== appOrigin())
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
    !acceptsFingerprint(node, connectionFingerprints.get(ws) ?? "")
  ) {
    ws.close(4003, "revoked");
    return;
  }
  if (p.type === "cert.renew") {
    const request = z
      .object({
        requestId: z.string().min(1).max(100),
        csrPem: z.string().max(10000),
      })
      .parse(p);
    try {
      const issued = await renewCertificate(id, request.csrPem);
      ws.send(
        JSON.stringify({
          type: "cert.renewed",
          requestId: request.requestId,
          ...issued,
        }),
      );
    } catch {
      ws.send(
        JSON.stringify({
          type: "cert.renew.error",
          requestId: request.requestId,
          error: "证书续期被拒绝，请检查节点身份",
        }),
      );
    }
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
  if (p.type === "task.started" && p.taskId) {
    const task = await db().task.findFirst({
      where: { id: p.taskId, nodeId: id, status: "DISPATCHED" },
    });
    if (task) {
      const payload = task.payload as Record<string, unknown>;
      const seconds = Math.min(
        3600,
        Math.max(600, Number(payload.timeoutSeconds ?? 0) + 60),
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
        !acceptsFingerprint(node, connectionFingerprints.get(ws) ?? "")
      ) {
        ws.close(4003, "revoked");
        continue;
      }
      if (ws.readyState !== WebSocket.OPEN) continue;
      const count = await db().task.count({
        where: { nodeId, status: { in: ["DISPATCHED", "RUNNING"] } },
      });
      if (count >= 4) continue;
      const upgrading = await db().task.count({
        where: {
          nodeId,
          type: "agent.upgrade",
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
          (task.type === "agent.upgrade" &&
            (count > 0 || tasks.some((t) => t.type !== "agent.upgrade")))
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
          if (task.type === "agent.upgrade") upgradeDispatched = true;
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
enrollment.listen(
  Number(process.env.ENROLL_PORT ?? 9444),
  process.env.GATEWAY_HOST ?? "0.0.0.0",
  () => console.log("TLS enrollment/terminal gateway ready"),
);
agents.listen(
  Number(process.env.GATEWAY_PORT ?? 9443),
  process.env.GATEWAY_HOST ?? "0.0.0.0",
  () => console.log("mTLS agent gateway ready"),
);
async function shutdown() {
  clearInterval(timer);
  for (const ws of connections.values()) ws.close(1001, "shutdown");
  for (const t of terminals.values()) t.socket.close(1001, "shutdown");
  await Promise.all([
    new Promise<void>((r) => agents.close(() => r())),
    new Promise<void>((r) => enrollment.close(() => r())),
  ]);
  await db().$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
