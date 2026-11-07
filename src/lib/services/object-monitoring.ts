import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { ApiError, authorize, nodeFilter, type Actor } from "../auth";
import { redisCall, redis } from "../redis";
import {
  frameObservations,
  objectHistoryResolution,
  objectMetricUnits,
  processIdentity,
  processObjectId,
  type ObjectKind,
  type Observation,
} from "../object-monitoring";
import {
  snapshotFresh,
  type TelemetryFrame,
  type Snapshot,
} from "../telemetry";

export const watchChannel = "pko:process-watches:changed";
async function authorizedNode(
  actor: Actor,
  nodeId: string,
  scope = "nodes:read",
) {
  authorize(actor, scope, nodeId);
  if (
    !(await db().node.findFirst({
      where: { ...nodeFilter(actor), id: nodeId },
      select: { id: true },
    }))
  )
    throw new ApiError(404, "节点不存在或没有访问权限");
}
export async function desiredWatches(nodeId: string) {
  return db().$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "ProcessWatchConfig" ("nodeId") VALUES (${nodeId}) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "nodeId" FROM "ProcessWatchConfig" WHERE "nodeId"=${nodeId} FOR SHARE`;
    const config = await tx.processWatchConfig.findUniqueOrThrow({
      where: { nodeId },
    });
    const watches = await tx.processWatch.findMany({
      where: { nodeId },
      orderBy: { createdAt: "asc" },
    });
    return {
      revision: config.revision,
      ackRevision: config.ackRevision,
      ackedAt: config.ackedAt,
      watches,
    };
  });
}
export async function listProcessWatches(actor: Actor, nodeId: string) {
  await authorizedNode(actor, nodeId);
  return desiredWatches(nodeId);
}
async function notifyWatches(nodeId: string) {
  try {
    await redisCall(async () => (await redis()).publish(watchChannel, nodeId));
  } catch {
    /* Durable revision is reconciled every 30 seconds. */
  }
}
export async function saveProcessWatch(
  actor: Actor,
  input: { nodeId: string; bootId: string; pid: number; startTicks: string },
) {
  await authorizedNode(actor, input.nodeId, "nodes:write");
  const identity = processIdentity.parse(input);
  const objectId = processObjectId(identity);
  const stored = await db().nodeTelemetry.findUnique({
    where: { nodeId_category: { nodeId: input.nodeId, category: "details" } },
  });
  const snapshot = stored?.snapshot as Snapshot | undefined;
  if (
    !snapshot ||
    !snapshotFresh(snapshot) ||
    snapshot.bootId !== identity.bootId ||
    snapshot.data.historyVersion !== 1
  )
    throw new ApiError(
      409,
      "需要支持对象历史的新版 Agent 和当前有效的实例采样",
    );
  const candidates = [
    snapshot.data.processes,
    snapshot.data.memoryTop,
    snapshot.data.processHistory,
  ].flatMap((v) => (Array.isArray(v) ? v : []));
  const row = candidates.find((v) => {
    const p = processIdentity.safeParse(v);
    return p.success && processObjectId(p.data) === objectId;
  }) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(409, "此准确进程实例未在当前采样中，请重新定位");
  await db().$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "ProcessWatchConfig" ("nodeId") VALUES (${input.nodeId}) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "nodeId" FROM "ProcessWatchConfig" WHERE "nodeId"=${input.nodeId} FOR UPDATE`;
    if (
      await tx.processWatch.findUnique({
        where: { nodeId_objectId: { nodeId: input.nodeId, objectId } },
      })
    )
      return;
    if (
      (await tx.processWatch.count({ where: { nodeId: input.nodeId } })) >= 20
    )
      throw new ApiError(409, "每节点最多关注20个准确实例");
    await tx.processWatch.create({
      data: {
        nodeId: input.nodeId,
        objectId,
        ...identity,
        name: String(row.name ?? "").slice(0, 200),
      },
    });
    await tx.processWatchConfig.update({
      where: { nodeId: input.nodeId },
      data: { revision: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        nodeId: input.nodeId,
        resourceId: objectId,
        resourceType: "ProcessWatch",
        action: "nodes.processWatches.save",
        detail: identity,
      },
    });
  });
  await notifyWatches(input.nodeId);
  return desiredWatches(input.nodeId);
}
export async function deleteProcessWatch(
  actor: Actor,
  nodeId: string,
  objectId: string,
) {
  await authorizedNode(actor, nodeId, "nodes:write");
  await db().$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "ProcessWatchConfig" ("nodeId") VALUES (${nodeId}) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "nodeId" FROM "ProcessWatchConfig" WHERE "nodeId"=${nodeId} FOR UPDATE`;
    const result = await tx.processWatch.deleteMany({
      where: { nodeId, objectId },
    });
    if (!result.count) return;
    await tx.processWatchConfig.update({
      where: { nodeId },
      data: { revision: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        nodeId,
        resourceId: objectId,
        resourceType: "ProcessWatch",
        action: "nodes.processWatches.delete",
      },
    });
  });
  await notifyWatches(nodeId);
  return desiredWatches(nodeId);
}
export async function acknowledgeWatches(nodeId: string, revision: number) {
  await db().processWatchConfig.updateMany({
    where: { nodeId, revision },
    data: { ackRevision: revision, ackedAt: new Date() },
  });
}

type StoredState = {
  kind: ObjectKind;
  objectId: string;
  bootId: string;
  state: string;
  coverage: string;
  identity: Record<string, unknown>;
  recordedAt: Date;
};
/** One transaction owns deduplication, observed transitions, watch exits and raw data. */
export async function storeObjectFrame(nodeId: string, frame: TelemetryFrame) {
  const at = new Date(frame.sampledAt);
  if (
    at.getTime() < Date.now() - 7 * 86400000 ||
    at.getTime() > Date.now() + 30000
  )
    return;
  await db().$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${nodeId}),hashtext(${frame.category}))::text`;
      const cursor = await tx.monitoringIngestCursor.findUnique({
        where: { nodeId_category: { nodeId, category: frame.category } },
      });
      if (cursor && cursor.recordedAt >= at) return;
      const elapsed = cursor ? at.getTime() - cursor.recordedAt.getTime() : 0;
      const expected = {
        fast: 5000,
        disks: 15000,
        details: 30000,
        static: 600000,
        legacy: 15000,
      }[frame.category];
      const gap =
        !!cursor &&
        (cursor.bootId !== frame.bootId ||
          elapsed > expected * 2 ||
          (frame.bootId === cursor.bootId &&
            BigInt(frame.sequence) > cursor.sequence + 1n));
      const observations = frameObservations(frame, elapsed);
      const previous = (await tx.monitoringState.findMany({
        where: {
          nodeId,
          kind:
            frame.category === "details"
              ? { in: ["process", "service", "container", "diagnostics"] }
              : "diagnostics",
        },
      })) as StoredState[];
      const prior = new Map(
        previous.map((s) => [`${s.kind}:${s.objectId}`, s]),
      );
      const present = new Set(
        observations.map((s) => `${s.kind}:${s.objectId}`),
      );
      // Disappearing from Top, incomplete enumeration and failed inspect are coverage
      // changes. Only an explicit, identity-checked Agent result can confirm exit.
      if (frame.category === "details")
        for (const old of previous) {
          if (
            old.kind === "diagnostics" ||
            present.has(`${old.kind}:${old.objectId}`) ||
            old.coverage === "not_covered" ||
            old.coverage === "exited"
          )
            continue;
          observations.push({
            kind: old.kind,
            objectId: old.objectId,
            identity: old.identity,
            state: "not_observed",
            coverage: "not_covered",
            reason: "本次未覆盖：榜外、采集失败或截断均不代表退出、停止或恢复",
            metrics: Object.fromEntries(
              Object.entries(objectMetricUnits[old.kind]).map(([k, unit]) => [
                k,
                { unit, value: null, weightMs: 1 },
              ]),
            ),
          });
        }
      if (
        frame.category === "details" &&
        frame.data.historyVersion === 1 &&
        Array.isArray(frame.data.watchResults)
      ) {
        for (const raw of frame.data.watchResults.slice(0, 20)) {
          const identity = processIdentity.safeParse(raw);
          if (
            !identity.success ||
            !(raw && typeof raw === "object") ||
            !["exited", "identity_changed"].includes(String(raw.status))
          )
            continue;
          const objectId = processObjectId(identity.data);
          const watch = await tx.processWatch.findUnique({
            where: { nodeId_objectId: { nodeId, objectId } },
          });
          if (!watch) continue;
          await tx.$queryRaw`SELECT "nodeId" FROM "ProcessWatchConfig" WHERE "nodeId"=${nodeId} FOR UPDATE`;
          await tx.processWatch.deleteMany({ where: { nodeId, objectId } });
          await tx.processWatchConfig.update({
            where: { nodeId },
            data: { revision: { increment: 1 } },
          });
          await tx.auditEvent.create({
            data: {
              nodeId,
              resourceId: objectId,
              resourceType: "ProcessWatch",
              action: "nodes.processWatches.ended",
              detail: { reason: String(raw.status) },
            },
          });
          const index = observations.findIndex(
            (o) => o.kind === "process" && o.objectId === objectId,
          );
          if (index >= 0) observations.splice(index, 1);
          observations.push({
            kind: "process",
            objectId,
            identity: { ...identity.data, name: watch.name },
            state: "exited",
            coverage: "exited",
            reason: String(raw.status),
            metrics: Object.fromEntries(
              Object.entries(objectMetricUnits.process).map(([k, unit]) => [
                k,
                { unit, value: null, weightMs: 1 },
              ]),
            ),
          });
        }
      }
      const samples: (Observation & { recordedAt: string; bootId: string })[] =
        observations.map((o) => ({
          ...o,
          recordedAt: frame.sampledAt,
          bootId: frame.bootId,
        }));
      if (gap && cursor) {
        const gapAt = new Date(
          Math.min(at.getTime() - 1, cursor.recordedAt.getTime() + expected),
        ).toISOString();
        for (const o of observations)
          samples.push({
            ...o,
            state: "sampling_gap",
            coverage: "gap",
            reason:
              cursor.bootId !== frame.bootId
                ? "节点重启分段"
                : "采样中断、乱序丢弃或遥测队列合并",
            metrics: Object.fromEntries(
              Object.entries(o.metrics).map(([k, p]) => [
                k,
                { ...p, value: null },
              ]),
            ),
            recordedAt: gapAt,
            bootId: cursor.bootId,
          });
      }
      const payload = JSON.stringify(samples);
      await tx.$executeRaw`INSERT INTO "MonitoringSample" ("nodeId",kind,"objectId","recordedAt","bootId",identity,state,coverage,reason,metrics)
      SELECT ${nodeId},kind,"objectId","recordedAt","bootId",identity,state,coverage,reason,metrics FROM jsonb_to_recordset(${payload}::jsonb) AS x(kind text,"objectId" text,"recordedAt" timestamptz,"bootId" text,identity jsonb,state text,coverage text,reason text,metrics jsonb) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO "MonitoringDirtyBucket" ("bucketAt") SELECT DISTINCT date_bin(interval '5 minutes',"recordedAt",'2000-01-01 UTC') FROM jsonb_to_recordset(${payload}::jsonb) AS x("recordedAt" timestamptz) ON CONFLICT DO NOTHING`;
      const events = observations.flatMap((o) => {
        const old = prior.get(`${o.kind}:${o.objectId}`);
        if (
          old &&
          old.bootId === frame.bootId &&
          old.state === o.state &&
          old.coverage === o.coverage &&
          old.identity.startedAt === o.identity.startedAt &&
          !gap
        )
          return [];
        const result = [
          {
            ...o,
            id: randomUUID(),
            fromState: old?.state ?? null,
            toState: o.state,
            recordedAt: frame.sampledAt,
            bootId: frame.bootId,
          },
        ];
        if (gap)
          result.unshift({
            ...o,
            id: randomUUID(),
            fromState: old?.state ?? null,
            toState: "sampling_gap",
            coverage: "gap",
            reason: "采样观察存在缺口；未推断间隔内的事件",
            recordedAt: new Date(at.getTime() - 1).toISOString(),
            bootId: frame.bootId,
          });
        return result;
      });
      if (events.length)
        await tx.$executeRaw`INSERT INTO "MonitoringEvent" (id,"nodeId",kind,"objectId","recordedAt","bootId",identity,"fromState","toState",coverage,reason)
      SELECT id,${nodeId},kind,"objectId","recordedAt","bootId",identity,"fromState","toState",coverage,reason FROM jsonb_to_recordset(${JSON.stringify(events)}::jsonb) AS x(id text,kind text,"objectId" text,"recordedAt" timestamptz,"bootId" text,identity jsonb,"fromState" text,"toState" text,coverage text,reason text)`;
      await tx.$executeRaw`INSERT INTO "MonitoringState" ("nodeId",kind,"objectId","recordedAt","bootId",identity,state,coverage)
      SELECT ${nodeId},kind,"objectId","recordedAt","bootId",identity,state,coverage FROM jsonb_to_recordset(${JSON.stringify(observations.map((o) => ({ ...o, recordedAt: frame.sampledAt, bootId: frame.bootId })))}::jsonb) AS x(kind text,"objectId" text,"recordedAt" timestamptz,"bootId" text,identity jsonb,state text,coverage text)
      ON CONFLICT ("nodeId",kind,"objectId") DO UPDATE SET "recordedAt"=EXCLUDED."recordedAt","bootId"=EXCLUDED."bootId",identity=EXCLUDED.identity,state=EXCLUDED.state,coverage=EXCLUDED.coverage`;
      await tx.monitoringIngestCursor.upsert({
        where: { nodeId_category: { nodeId, category: frame.category } },
        create: {
          nodeId,
          category: frame.category,
          recordedAt: at,
          bootId: frame.bootId,
          sequence: BigInt(frame.sequence),
        },
        update: {
          recordedAt: at,
          bootId: frame.bootId,
          sequence: BigInt(frame.sequence),
        },
      });
    },
    { timeout: 20000 },
  );
  if (
    frame.category === "details" &&
    Array.isArray(frame.data.watchResults) &&
    frame.data.watchResults.some(
      (r) => r && ["exited", "identity_changed"].includes(r.status),
    )
  )
    await notifyWatches(nodeId);
}

export type ObjectHistoryInput = {
  nodeId: string;
  kind: ObjectKind;
  metric?: string;
  hours: number;
  objectIds?: string[];
  from?: string;
  to?: string;
};
export async function objectHistory(actor: Actor, input: ObjectHistoryInput) {
  await authorizedNode(actor, input.nodeId);
  let range: ReturnType<typeof objectHistoryResolution>;
  try {
    range = objectHistoryResolution(input.hours, input.from, input.to);
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
  const metric = input.metric ?? Object.keys(objectMetricUnits[input.kind])[0];
  if (!(metric in objectMetricUnits[input.kind]))
    throw new ApiError(400, "对象指标与类别不匹配");
  const objects = await db().monitoringState.findMany({
    where: {
      nodeId: input.nodeId,
      kind: input.kind,
      recordedAt: { gte: range.start },
    },
    orderBy: { recordedAt: "desc" },
    take: 200,
    select: {
      objectId: true,
      identity: true,
      bootId: true,
      state: true,
      coverage: true,
      recordedAt: true,
    },
  });
  const ids = input.objectIds?.length
    ? [...new Set(input.objectIds)]
    : objects.slice(0, 1).map((o) => o.objectId);
  if (ids.length > 5) throw new ApiError(400, "同屏最多比较5个对象");
  const points = ids.length
    ? await db().$queryRaw<
        {
          objectId: string;
          recordedAt: Date;
          value: number | null;
          mean: number | null;
          maximum: number | null;
          validCount: number;
          gapCount: number;
          bootId: string | null;
        }[]
      >(Prisma.sql`
    WITH source AS (
      SELECT s."objectId",s."recordedAt",s."bootId",(s.metrics->${metric}->>'value')::double precision AS mean,
        (s.metrics->${metric}->>'value')::double precision AS maximum,
        CASE WHEN s.metrics->${metric}->>'value' IS NULL THEN 0 ELSE 1 END AS valid,
        CASE WHEN s.metrics->${metric}->>'value' IS NULL OR s.coverage<>'covered' THEN 1 ELSE 0 END AS gaps,
        coalesce((s.metrics->${metric}->>'weightMs')::double precision,1) AS weight
      FROM "MonitoringSample" s WHERE s."nodeId"=${input.nodeId} AND s.kind=${input.kind} AND s."objectId" IN (${Prisma.join(ids)}) AND s."recordedAt">=${range.start} AND s."recordedAt"<${range.end}
      UNION ALL
      SELECT a."objectId",a."bucketAt",a."bootId",(a.metrics->${metric}->>'mean')::double precision,(a.metrics->${metric}->>'maximum')::double precision,
        (a.metrics->${metric}->>'validCount')::integer,(a.metrics->${metric}->>'gapCount')::integer,
        coalesce((a.metrics->${metric}->>'weightMs')::double precision,1)
      FROM "MonitoringAggregate" a WHERE a."nodeId"=${input.nodeId} AND a.kind=${input.kind} AND a."objectId" IN (${Prisma.join(ids)}) AND a."bucketAt">=${range.start} AND a."bucketAt"<${range.end}
        AND NOT EXISTS(SELECT 1 FROM "MonitoringSample" s WHERE s."nodeId"=a."nodeId" AND s.kind=a.kind AND s."objectId"=a."objectId" AND s."bootId"=a."bootId" AND s."recordedAt">=a."bucketAt" AND s."recordedAt"<a."bucketAt"+interval '5 minutes')
    ), grouped AS (
      SELECT "objectId",date_bin(${range.bucketSeconds}::integer*interval '1 second',"recordedAt",${range.start}) AS t,
        sum(mean*weight)/nullif(sum(weight) FILTER(WHERE mean IS NOT NULL),0) AS mean,max(maximum) AS maximum,
        sum(valid)::integer AS valid,sum(gaps)::integer AS gaps,count(DISTINCT "bootId") AS boots,max("bootId") AS boot
      FROM source GROUP BY 1,2
    ), grid AS (SELECT id AS "objectId",t FROM unnest(ARRAY[${Prisma.join(ids)}]::text[]) id CROSS JOIN generate_series(${range.start}::timestamptz,${range.end}::timestamptz-interval '1 millisecond',${range.bucketSeconds}::integer*interval '1 second') t)
    SELECT grid."objectId",grid.t AS "recordedAt",CASE WHEN g.gaps>0 OR g.boots>1 THEN NULL ELSE g.mean END AS value,g.mean,g.maximum,
      coalesce(g.valid,0)::integer AS "validCount",coalesce(g.gaps,1)::integer AS "gapCount",g.boot AS "bootId"
    FROM grid LEFT JOIN grouped g ON g."objectId"=grid."objectId" AND g.t=grid.t ORDER BY grid.t`)
    : [];
  const current = await db().nodeTelemetry.findUnique({
    where: { nodeId_category: { nodeId: input.nodeId, category: "details" } },
    select: { snapshot: true },
  });
  const supports =
    input.kind === "diagnostics" ||
    (current?.snapshot as Snapshot | undefined)?.data.historyVersion === 1;
  return {
    kind: input.kind,
    metric,
    unit: objectMetricUnits[input.kind][metric],
    bucketSeconds: range.bucketSeconds,
    resolution: range.bucketSeconds >= 300 ? "aggregate" : "raw",
    from: range.start,
    to: range.end,
    coverage: supports ? "bounded" : "upgrade_required",
    reason: supports
      ? "Top20 CPU与内存去重及最多20个关注实例；服务/容器各最多200个；缺口不补零"
      : "需要升级 Agent 以采集准确对象身份与历史",
    objects,
    objectIds: ids,
    retention: { rawDays: 7, aggregateDays: 30, eventDays: 30 },
    series: ids.map((objectId) => ({
      objectId,
      identity: objects.find((o) => o.objectId === objectId)?.identity ?? {
        id: objectId,
      },
      name: objectId,
      points: points.filter((p) => p.objectId === objectId),
    })),
  };
}

export async function objectEvents(
  actor: Actor,
  input: {
    nodeId: string;
    kind: ObjectKind;
    objectId?: string;
    hours: number;
    from?: string;
    to?: string;
    cursor?: { recordedAt: string; id: string };
  },
) {
  await authorizedNode(actor, input.nodeId);
  let range: ReturnType<typeof objectHistoryResolution>;
  try {
    range = objectHistoryResolution(input.hours, input.from, input.to);
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
  const rows = await db().monitoringEvent.findMany({
    where: {
      nodeId: input.nodeId,
      kind: input.kind,
      ...(input.objectId ? { objectId: input.objectId } : {}),
      recordedAt: { gte: range.start, lt: range.end },
      ...(input.cursor
        ? {
            OR: [
              { recordedAt: { lt: new Date(input.cursor.recordedAt) } },
              {
                recordedAt: new Date(input.cursor.recordedAt),
                id: { lt: input.cursor.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    take: 101,
  });
  const events = rows.slice(0, 100);
  const last = events.at(-1);
  return {
    events,
    nextCursor:
      rows.length > 100 && last
        ? { recordedAt: last.recordedAt, id: last.id }
        : null,
    from: range.start,
    to: range.end,
    semantics: "采样观察到的状态变化，不代表采样间隔内的全部操作系统事件",
  };
}
