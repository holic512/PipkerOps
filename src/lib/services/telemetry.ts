/** Authorized lightweight node queries and durable/current telemetry storage. */
import { clusterProjection } from "../cluster-monitoring";
import { storeObjectFrame } from "./object-monitoring";
import { db } from "../db";
import { redis, redisCall } from "../redis";
import { authorize, ApiError, nodeFilter, type Actor } from "../auth";
import { Prisma } from "@/generated/prisma/client";
import {
  categories,
  snapshotKey,
  telemetryFrame,
  telemetryChannel,
  snapshotFresh,
  numericPercent,
  historyPayload,
  acceptSequence,
  preferredSnapshots,
  legacySeries,
  withLegacySeries,
  type Snapshot,
  type TelemetryFrame,
} from "../telemetry";

const omitted = {
  csrPem: true,
  certificatePem: true,
  certificateFingerprint: true,
  previousCertificateFingerprint: true,
  agentCredentialRef: true,
  agentCaPem: true,
} as const;
export async function getNode(actor: Actor, nodeId: string) {
  authorize(actor, "nodes:read", nodeId);
  const node = await db().node.findFirst({
    where: { ...nodeFilter(actor), id: nodeId },
    omit: omitted,
  });
  if (!node) throw new ApiError(404, "节点不存在或没有访问权限");
  return {
    ...node,
    connected:
      node.status === "APPROVED" &&
      !!node.agentId &&
      !!node.lastSeenAt &&
      Date.now() - node.lastSeenAt.getTime() < 60000,
    metrics: [],
  };
}
type StoredSnapshot = Snapshot & { nodeId: string; cacheFallback: boolean };
export async function readSnapshots(
  nodeIds: string[],
  category?: string,
  compact = false,
) {
  if (!nodeIds.length) return [] as StoredSnapshot[];
  const chosen = category ? [category] : [...categories];
  const keys = nodeIds.flatMap((id) =>
    chosen.map((c) => snapshotKey(id, compact ? "summary" : c)),
  );
  const cached = new Map<string, StoredSnapshot>();
  try {
    const values = await redisCall(async () => (await redis()).mGet(keys));
    values.forEach((raw, index) => {
      if (!raw) return;
      try {
        const value = JSON.parse(raw) as Snapshot;
        cached.set(keys[index], {
          ...value,
          nodeId: nodeIds[Math.floor(index / chosen.length)],
          cacheFallback: false,
        });
      } catch {
        /* Invalid cache entry: use durable state. */
      }
    });
    if (cached.size === keys.length) return [...cached.values()];
  } catch {
    /* Cache loss does not hide persisted samples. */
  }
  const missingIds = nodeIds.filter((id) =>
    chosen.some((c) => !cached.has(snapshotKey(id, compact ? "summary" : c))),
  );
  const rows = await db().$queryRaw<{ nodeId: string; snapshot: Snapshot }[]>(
    Prisma.sql`SELECT "nodeId",snapshot FROM "NodeTelemetry" WHERE "nodeId" IN (${Prisma.join(missingIds)}) ${category ? Prisma.sql`AND category=${category}` : Prisma.empty}`,
  );
  for (const row of rows) {
    const key = snapshotKey(
      row.nodeId,
      compact ? "summary" : row.snapshot.category,
    );
    if (!cached.has(key))
      cached.set(key, {
        ...row.snapshot,
        nodeId: row.nodeId,
        cacheFallback: true,
      });
  }
  return [...cached.values()];
}
export async function getSnapshot(
  actor: Actor,
  nodeId: string,
  category?: string,
) {
  const node = await getNode(actor, nodeId);
  let values = await readSnapshots([nodeId], category);
  if (!values.length && category && category !== "legacy")
    values = await readSnapshots([nodeId], "legacy");
  if (!values.length) {
    const latest = await db().metricSample.findFirst({
      where: { nodeId },
      orderBy: { recordedAt: "desc" },
    });
    if (latest)
      values = [
        {
          nodeId,
          cacheFallback: true,
          schemaVersion: 2,
          bootId: "legacy",
          sequence: 0,
          category: "legacy",
          sampledAt: latest.recordedAt.toISOString(),
          receivedAt: latest.recordedAt.toISOString(),
          durationMs: 0,
          data: {
            cpuPercent: latest.cpuPercent,
            memoryPercent: latest.memoryPercent,
            ...(latest.payload as Record<string, unknown>),
          },
          series: [],
          errors: ["旧采样：部分指标不可用"],
          truncated: false,
        },
      ];
  }
  if (!category) values = preferredSnapshots(values);
  values = values.map(withLegacySeries);
  return {
    nodeId,
    connected: node.connected,
    categories: values.map((value) => ({
      ...value,
      stale: !node.connected || !snapshotFresh(value),
    })),
    payload: Object.assign({}, ...values.map((s) => s.data)),
    legacy: values.length > 0 && values.every((s) => s.category === "legacy"),
  };
}
export async function nodeSummary(actor: Actor) {
  authorize(actor, "nodes:read");
  const rows = await db().node.findMany({
    where: nodeFilter(actor),
    omit: omitted,
    orderBy: { createdAt: "desc" },
  });
  const snapshots = await readSnapshots(
    rows.map((n) => n.id),
    "fast",
    true,
  );
  const byNode = new Map(snapshots.map((s) => [s.nodeId, s]));
  const missing = rows.filter((n) => !byNode.has(n.id)).map((n) => n.id);
  const fallback = missing.length
    ? await db().$queryRaw<
        {
          nodeId: string;
          recordedAt: Date;
          cpuPercent: number | null;
          memoryPercent: number | null;
        }[]
      >(
        Prisma.sql`SELECT sample."nodeId",sample."recordedAt",sample."cpuPercent",sample."memoryPercent" FROM unnest(ARRAY[${Prisma.join(missing)}]::text[]) requested(id) CROSS JOIN LATERAL (SELECT "nodeId","recordedAt","cpuPercent","memoryPercent" FROM "MetricSample" WHERE "nodeId"=requested.id ORDER BY "recordedAt" DESC LIMIT 1) sample`,
      )
    : [];
  const old = new Map(fallback.map((s) => [s.nodeId, s]));
  return rows.map((node) => {
    const s = byNode.get(node.id),
      f = old.get(node.id);
    const connected =
      node.status === "APPROVED" &&
      !!node.agentId &&
      !!node.lastSeenAt &&
      Date.now() - node.lastSeenAt.getTime() < 60000;
    return {
      ...node,
      connected,
      stale:
        !connected ||
        (s
          ? s.cacheFallback || !snapshotFresh(s)
          : !f || Date.now() - f.recordedAt.getTime() > 45000),
      metrics:
        s || f
          ? [
              {
                recordedAt: s?.sampledAt ?? f!.recordedAt,
                cpuPercent: numericPercent(s?.data.cpuPercent ?? f?.cpuPercent),
                memoryPercent: numericPercent(
                  s?.data.memoryPercent ?? f?.memoryPercent,
                ),
                payload: {},
              },
            ]
          : [],
    };
  });
}

/** One latest pending frame per category. Telemetry never blocks task/PTY processing. */
export function telemetryQueue(
  consume: (frame: TelemetryFrame) => Promise<void>,
  report: (error: unknown) => void,
) {
  const pending = new Map<string, TelemetryFrame>();
  const newest = new Map<string, TelemetryFrame>();
  let running: Promise<void> | undefined;
  function push(frame: TelemetryFrame) {
    const previous = newest.get(frame.category);
    if (
      previous &&
      previous.bootId === frame.bootId &&
      previous.sequence >= frame.sequence
    )
      return;
    newest.set(frame.category, frame);
    pending.set(frame.category, frame);
    running ??= drain().finally(() => {
      running = undefined;
    });
  }
  async function drain() {
    while (pending.size) {
      const [key, frame] = pending.entries().next().value!;
      pending.delete(key);
      try {
        await consume(frame);
      } catch (e) {
        report(e);
      }
    }
  }
  return {
    push,
    idle: () => running ?? Promise.resolve(),
    size: () => pending.size,
  };
}

export function telemetryWriter(nodeId: string, valid: () => boolean) {
  const latest = new Map<string, Snapshot>();
  let lastHistory = 0;
  return async (frame: TelemetryFrame) => {
    if (!valid() || !acceptSequence(latest.get(frame.category), frame)) return;
    const previous = latest.get(frame.category);
    if (previous && frame.category === "fast") {
      const present = new Set(
        frame.series.map((p) => `${p.metric}:${p.device}`),
      );
      frame = {
        ...frame,
        series: [
          ...frame.series,
          ...previous.series
            .filter((p) => !p.device && !present.has(`${p.metric}:${p.device}`))
            .map((p) => ({ ...p, value: null })),
        ],
      };
    }
    // Retain the last fully successful collection across reconnects/restarts.
    const persisted =
      previous ?? (await readSnapshots([nodeId], frame.category))[0];
    if (persisted && Date.parse(frame.sampledAt) <= Date.parse(persisted.sampledAt)) return;
    const snapshot: Snapshot = {
      ...frame,
      receivedAt: new Date().toISOString(),
      lastSuccessAt:
        frame.errors.length === 0 ? frame.sampledAt : persisted?.lastSuccessAt,
    };
    await storeObjectFrame(nodeId, frame);
    latest.set(frame.category, snapshot);
    await db()
      .$executeRaw`INSERT INTO "NodeTelemetry" ("nodeId",category,snapshot,"receivedAt") VALUES (${nodeId},${frame.category},${JSON.stringify(snapshot)}::jsonb,${new Date(snapshot.receivedAt)}) ON CONFLICT ("nodeId",category) DO UPDATE SET snapshot=EXCLUDED.snapshot,"receivedAt"=EXCLUDED."receivedAt" WHERE "NodeTelemetry"."receivedAt"<=EXCLUDED."receivedAt"`;
    if (!valid()) return;
    if (Array.isArray(frame.data.containers)) {
      const deployments = await db().deployment.findMany({
        where: { nodeId, type: "docker", healthUrl: null },
      });
      for (const deployment of deployments) {
        const container = frame.data.containers.find((value: unknown) => {
          const c = value as Record<string, unknown> | null;
          return (
            c && (c.id === deployment.target || c.name === deployment.target)
          );
        });
        if (container) {
          const status = String(container.state ?? "UNKNOWN");
          if (status !== deployment.status)
            await db().deployment.update({
              where: { id: deployment.id },
              data: { status },
            });
        }
      }
    }
    const values = [...latest.values()].filter((s) => snapshotFresh(s));
    const payload = historyPayload(values);
    if (
      Date.now() - lastHistory >= 15000 &&
      (frame.category === "fast" || frame.category === "legacy")
    ) {
      const points = values.flatMap((s) => s.series);
      await db().$transaction(async (tx) => {
        await tx.metricSample.create({
          data: {
            nodeId,
            cpuPercent: numericPercent(payload.cpuPercent),
            memoryPercent: numericPercent(payload.memoryPercent),
            payload: payload as Prisma.InputJsonObject,
          },
        });
        await tx.$executeRaw`INSERT INTO "TelemetrySample" ("nodeId","recordedAt",series) VALUES (${nodeId},now(),${JSON.stringify(points)}::jsonb)`;
      });
      lastHistory = Date.now();
    }
    try {
      if (!valid()) return;
      await redisCall(async () => {
        const c = await redis();
        await c.eval(
          `local old=redis.call('GET',KEYS[1]); if old then local v=cjson.decode(old); if v.receivedAt>ARGV[2] then return 0 end end; redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[3]); if ARGV[4]~='' then local summary=redis.call('GET',KEYS[2]); if not summary or cjson.decode(summary).receivedAt<=ARGV[2] then redis.call('SET',KEYS[2],ARGV[4],'EX',120) end end; return 1`,
          {
            keys: [
              snapshotKey(nodeId, frame.category),
              snapshotKey(nodeId, "summary"),
            ],
            arguments: [
              JSON.stringify(snapshot),
              snapshot.receivedAt,
              String(frame.category === "static" ? 1800 : 120),
              ["fast", "legacy"].includes(frame.category)
                ? JSON.stringify({
                    ...snapshot,
                    data: {
                      cpuPercent: numericPercent(snapshot.data.cpuPercent),
                      memoryPercent: numericPercent(
                        snapshot.data.memoryPercent,
                      ),
                    },
                    series: [],
                  })
                : "",
            ],
          },
        );
        await c.publish(
          telemetryChannel,
          JSON.stringify({ nodeId, category: frame.category }),
        );
      });
    } catch {
      /* History is already durable. SSE polling recovers cache outages. */
    }
  };
}
export function legacyFrame(payload: Record<string, unknown>): TelemetryFrame {
  return telemetryFrame.parse({
    schemaVersion: 2,
    bootId: "legacy",
    sequence: Date.now(),
    category: "legacy",
    sampledAt: new Date().toISOString(),
    durationMs: 0,
    data: payload,
    series: legacySeries(payload),
    errors: Array.isArray(payload.collectionErrors)
      ? payload.collectionErrors
      : [],
  });
}

/** Cross-node diagnostics remain an authorized compact projection. */
export async function nodeMonitoring(actor: Actor) {
  const nodes = await nodeSummary(actor);
  const snapshots = await readSnapshots(nodes.map((n) => n.id));
  const byNode = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    const values = byNode.get(s.nodeId) ?? [];
    values.push(s);
    byNode.set(s.nodeId, values);
  }
  const now = Date.now();
  return nodes.map((node) =>
    clusterProjection(node, byNode.get(node.id) ?? [], now),
  );
}
