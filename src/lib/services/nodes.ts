/**
 * @file nodes.ts
 * @project PipkerOps
 * @module nodes
 * @description Agent 接入文件导入、停用与指标查询的统一服务。
 * @logic 节点按授权过滤，最新指标在数据库逐节点LIMIT 1；导入验证 Agent 身份并保存私有凭证，历史按时间桶聚合并合并原始尾部。
 * @dependencies Prisma, Agent HTTPS, authorization
 * @index_tags nodes, enrollment, metrics
 * @author holic512
 */
import { z } from "zod";
import { db } from "../db";
import { ApiError, authorize, confirm, nodeFilter, type Actor } from "../auth";
import { randomUUID } from "node:crypto";
import {
  saveCredential,
  testAgent,
  agentRequest,
  readCredential,
} from "../agent-connection";
import { methodSchemas } from "./contracts";
import { Prisma, type MetricSample } from "@/generated/prisma/client";
export async function listNodes(actor: Actor) {
  authorize(actor, "nodes:read");
  const now = Date.now();
  const rows = await db().node.findMany({
    where: nodeFilter(actor),
    omit: {
      csrPem: true,
      certificatePem: true,
      certificateFingerprint: true,
      previousCertificateFingerprint: true,
      agentCredentialRef: true,
      agentCaPem: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const latest = await withLatestMetrics(rows);
  return latest.map((n) => ({
    ...n,
    connected:
      n.status === "APPROVED" &&
      !!n.agentId &&
      !!n.lastSeenAt &&
      now - n.lastSeenAt.getTime() < 60000,
  }));
}

/** Attach at most one stored sample per already-authorized node. */
export async function withLatestMetrics<T extends { id: string }>(rows: T[]) {
  const samples = rows.length
    ? await db().$queryRaw<MetricSample[]>(
        latestMetricQuery(rows.map((n) => n.id)),
      )
    : [];
  const latest = new Map(samples.map((sample) => [sample.nodeId, sample]));
  return rows.map((node) => ({
    ...node,
    metrics: latest.has(node.id) ? [latest.get(node.id)!] : [],
  }));
}

/** Relation take:1 can fetch all histories before Prisma slices them in memory. */
export function latestMetricQuery(nodeIds: string[]) {
  return Prisma.sql`
    SELECT latest.*
    FROM unnest(ARRAY[${nodeIds.length ? Prisma.join(nodeIds) : Prisma.empty}]::text[]) AS requested("nodeId")
    CROSS JOIN LATERAL (
      SELECT sample.* FROM "MetricSample" sample
      WHERE sample."nodeId" = requested."nodeId"
      ORDER BY sample."recordedAt" DESC
      LIMIT 1
    ) latest
  `;
}
export async function testConnection(actor: Actor, input: unknown) {
  authorize(actor, "nodes:approve");
  const { connection } = methodSchemas["nodes.test"].parse(input);
  return testAgent(connection);
}
export async function importNode(actor: Actor, input: unknown) {
  const data = methodSchemas["nodes.import"].parse(input);
  authorize(actor, "nodes:approve", data.id, true);
  confirm(data.confirmed);
  const info = await testAgent(data.connection);
  const existing = data.id
    ? await db().node.findUnique({ where: { id: data.id } })
    : null;
  if (data.id && !existing) throw new ApiError(404, "节点不存在");
  const duplicate = await db().node.findUnique({
    where: { agentId: info.agentId },
  });
  if (duplicate && duplicate.id !== data.id)
    throw new ApiError(409, "此 Agent 已接入，请选择原节点重新接入");
  const ref = randomUUID();
  await saveCredential(ref, data.connection.accessKey);
  return db().$transaction(async (tx) => {
    const fields = {
      name: data.name ?? existing?.name ?? info.name,
      hostname: info.hostname,
      os: info.os,
      arch: info.arch,
      agentVersion: info.agentVersion,
      agentId: info.agentId,
      agentUrl: new URL(data.connection.url).origin,
      agentCaPem: data.connection.caPem,
      agentCredentialRef: ref,
      deployRoot: info.deployRoot,
      status: "APPROVED" as const,
      connectionError: null,
      lastSeenAt: null,
      approvedById: actor.userId,
      approvedAt: new Date(),
    };
    const node = existing
      ? await tx.node.update({ where: { id: existing.id }, data: fields })
      : await tx.node.create({ data: fields });
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        action: "nodes.import",
        resourceType: "Node",
        resourceId: node.id,
        nodeId: node.id,
      },
    });
    return { id: node.id, name: node.name };
  });
}
export async function registerDeployment(actor: Actor, input: unknown) {
  const data = methodSchemas["nodes.deployment"].parse(input);
  authorize(actor, "nodes:approve", data.nodeId, true);
  confirm(data.confirmed);
  const node = await db().node.findUniqueOrThrow({
    where: { id: data.nodeId },
  });
  if (!node.agentUrl || !node.agentCaPem || !node.agentCredentialRef)
    throw new ApiError(409, "节点尚未接入");
  const installation = z
    .object({
      root: z.literal(data.deployRoot),
      components: z.array(z.string()),
      scriptsVersion: z.string(),
      managedFiles: z.boolean().default(false),
    })
    .parse(
      await agentRequest(
        {
          url: node.agentUrl,
          caPem: node.agentCaPem,
          accessKey: await readCredential(node.agentCredentialRef),
        },
        `/v1/installation?root=${encodeURIComponent(data.deployRoot)}`,
      ),
    );
  if (data.component === "scripts" && !installation.managedFiles)
    throw new ApiError(
      400,
      "此目录缺少正式发布程序清单，请先使用部署包安装脚本",
    );
  if (
    data.component !== "scripts" &&
    !installation.components.includes(data.component)
  )
    throw new ApiError(400, "指定目录未安装所选组件");
  await db().node.update({
    where: { id: node.id },
    data: { deployRoot: data.deployRoot },
  });
  await db().auditEvent.create({
    data: {
      actorId: actor.userId,
      action: "nodes.deployment",
      resourceType: "Node",
      resourceId: node.id,
      nodeId: node.id,
      detail: { deployRoot: data.deployRoot },
    },
  });
  return installation;
}
export async function changeNode(actor: Actor, id: string) {
  authorize(actor, "nodes:approve", id, true);
  return db().$transaction(async (tx) => {
    await tx.node.update({
      where: { id },
      data: { status: "REVOKED", lastSeenAt: null },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        action: "nodes.revoke",
        resourceType: "Node",
        resourceId: id,
        nodeId: id,
      },
    });
    return { id, status: "REVOKED" };
  });
}
export async function metrics(actor: Actor, nodeId: string, hours = 24) {
  authorize(actor, "nodes:read", nodeId);
  const history = metricHistoryQuery(nodeId, hours);
  return {
    resolution: history.resolution,
    bucketSeconds: history.bucketSeconds,
    samples: await db().$queryRaw<MetricHistorySample[]>(history.query),
  };
}

type MetricHistorySample = {
  recordedAt?: Date;
  bucketAt?: Date;
  sampleCount: number;
  cpuPercent?: number;
  memoryPercent?: number;
  cpuAvg?: number;
  memoryAvg?: number;
  cpuMax: number;
  memoryMax: number;
};

/** Parameterized SQL is shared with isolated PostgreSQL tests; no payload is read. */
export function metricHistoryQuery(
  nodeId: string,
  hours: number,
  now = new Date(),
) {
  if (!Number.isFinite(hours) || hours < 1 || hours > 8760)
    throw new ApiError(400, "查询时间范围无效");
  const since = new Date(now.getTime() - hours * 3600000);
  if (hours > 48)
    return {
      resolution: "hour" as const,
      bucketSeconds: 3600,
      // Raw data wins for every bucket that still has retained samples. This
      // includes late arrivals since daily maintenance, without double counting.
      query: Prisma.sql`
        WITH raw AS MATERIALIZED (
          SELECT date_trunc('hour', "recordedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "bucketAt",
                 count(*)::integer AS "sampleCount",
                 avg("cpuPercent") AS "cpuAvg", max("cpuPercent") AS "cpuMax",
                 avg("memoryPercent") AS "memoryAvg", max("memoryPercent") AS "memoryMax"
          FROM "MetricSample"
          WHERE "nodeId" = ${nodeId}
            AND "recordedAt" >= ${since}::timestamptz AND "recordedAt" < ${now}::timestamptz
          GROUP BY 1
        )
        SELECT "bucketAt", "sampleCount", "cpuAvg", "cpuMax", "memoryAvg", "memoryMax"
        FROM raw
        UNION ALL
        SELECT h."bucketAt", h."sampleCount", h."cpuAvg", h."cpuMax", h."memoryAvg", h."memoryMax"
        FROM "MetricHourly" h
        WHERE h."nodeId" = ${nodeId}
          AND h."bucketAt" >= date_trunc('hour', ${since}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND h."bucketAt" < ${now}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM raw r WHERE r."bucketAt" = h."bucketAt")
        ORDER BY "bucketAt" ASC`,
    };
  const bucketSeconds = Math.ceil((hours * 3600) / 1440);
  return {
    resolution: "raw" as const,
    bucketSeconds,
    // Half-open bounds and an origin at the requested start cap the result at
    // 1440 points, including both ends of the requested range without LIMIT loss.
    query: Prisma.sql`
      SELECT date_bin(${bucketSeconds}::integer * interval '1 second', "recordedAt", ${since}::timestamptz) AS "recordedAt",
             count(*)::integer AS "sampleCount",
             avg("cpuPercent") AS "cpuPercent", max("cpuPercent") AS "cpuMax",
             avg("memoryPercent") AS "memoryPercent", max("memoryPercent") AS "memoryMax"
      FROM "MetricSample"
      WHERE "nodeId" = ${nodeId}
        AND "recordedAt" >= ${since}::timestamptz AND "recordedAt" < ${now}::timestamptz
      GROUP BY 1
      ORDER BY "recordedAt" ASC`,
  };
}
