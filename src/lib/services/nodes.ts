/**
 * @file nodes.ts
 * @project PipkerOps
 * @module nodes
 * @description 节点注册、审批、吊销、指标查询的统一服务。
 * @logic 原子消费注册令牌；证书绑定节点；历史指标按时间桶聚合并合并原始尾部；查询按 API Key 节点范围过滤。
 * @dependencies Prisma, PKI, authorization
 * @index_tags nodes, enrollment, metrics
 * @author holic512
 */
import { z } from "zod";
import { db } from "../db";
import { ApiError, authorize, nodeFilter, type Actor } from "../auth";
import { randomToken, hashToken } from "../crypto";
import { issueCertificate, validateCsr, pkiFiles } from "../pki";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { methodSchemas } from "./contracts";
import { Prisma } from "@/generated/prisma/client";
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
    },
    orderBy: { createdAt: "desc" },
    include: { metrics: { take: 1, orderBy: { recordedAt: "desc" } } },
  });
  return rows.map((n) => ({
    ...n,
    connected:
      n.status === "APPROVED" &&
      !!n.lastSeenAt &&
      now - n.lastSeenAt.getTime() < 60000,
  }));
}
export async function enrollmentToken(actor: Actor, input: unknown) {
  authorize(actor, "nodes:approve");
  const data = methodSchemas["nodes.token"].parse(input);
  const token = randomToken();
  const result = await db().$transaction(async (tx) => {
    const t = await tx.enrollmentToken.create({
      data: {
        name: data.name,
        maxUses: data.maxUses,
        expiresAt: new Date(Date.now() + data.hours * 3600000),
        tokenHash: hashToken(token),
        createdById: actor.userId,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        action: "nodes.enrollment-token",
        resourceType: "EnrollmentToken",
        resourceId: t.id,
      },
    });
    return t;
  });
  return {
    id: result.id,
    token,
    expiresAt: result.expiresAt,
    gateway: process.env.GATEWAY_PUBLIC_URL,
    enrollUrl: process.env.ENROLL_PUBLIC_URL,
  };
}
export async function enroll(input: unknown) {
  const data = z
    .object({
      token: z.string().min(20).max(256),
      name: z.string().min(1).max(120),
      hostname: z.string().max(255),
      os: z.string().max(80),
      arch: z.string().max(32),
      agentVersion: z.string().max(64),
      csrPem: z.string().max(10000),
    })
    .parse(input);
  try {
    validateCsr(data.csrPem);
  } catch {
    throw new ApiError(400, "无效的节点 CSR");
  }
  return db().$transaction(async (tx) => {
    const token = await tx.enrollmentToken.findUnique({
      where: { tokenHash: hashToken(data.token) },
    });
    if (!token || token.expiresAt < new Date())
      throw new ApiError(403, "注册令牌无效或过期");
    const existing = await tx.node.findFirst({
      where: { enrollmentTokenId: token.id, csrPem: data.csrPem },
    });
    if (existing) return { id: existing.id, status: existing.status };
    const consumed = await tx.enrollmentToken.updateMany({
      where: {
        id: token.id,
        usedCount: { lt: token.maxUses },
        expiresAt: { gt: new Date() },
      },
      data: { usedCount: { increment: 1 } },
    });
    if (!consumed.count) throw new ApiError(403, "注册令牌使用次数已耗尽");
    const node = await tx.node.create({
      data: {
        name: data.name,
        hostname: data.hostname,
        os: data.os,
        arch: data.arch,
        agentVersion: data.agentVersion,
        csrPem: data.csrPem,
        enrollmentTokenId: token.id,
      },
    });
    await tx.auditEvent.create({
      data: {
        action: "nodes.enroll",
        resourceType: "Node",
        resourceId: node.id,
        nodeId: node.id,
      },
    });
    return { id: node.id, status: node.status };
  });
}
export async function enrollmentStatus(input: unknown) {
  const data = z
    .object({
      token: z.string().max(256),
      nodeId: z.string().max(100),
      csrPem: z.string().max(10000),
    })
    .parse(input);
  const node = await db().node.findUnique({
    where: { id: data.nodeId },
    include: { enrollmentToken: true },
  });
  if (
    !node ||
    node.csrPem !== data.csrPem ||
    node.enrollmentToken?.tokenHash !== hashToken(data.token)
  )
    throw new ApiError(403, "节点注册身份不匹配");
  return {
    id: node.id,
    status: node.status,
    certificatePem:
      node.status === "APPROVED" ? node.certificatePem : undefined,
    caPem:
      node.status === "APPROVED"
        ? readFileSync(/* turbopackIgnore: true */ pkiFiles().ca, "utf8")
        : undefined,
  };
}
export async function changeNode(actor: Actor, id: string, action: string) {
  authorize(actor, "nodes:approve", id, true);
  const node = await db().node.findUnique({ where: { id } });
  if (!node) throw new ApiError(404, "节点不存在");
  let certificate = {};
  if (action === "approve") {
    if (node.status !== "PENDING" || !node.csrPem)
      throw new ApiError(409, "节点当前不能审批");
    certificate = issueCertificate(id, node.csrPem);
  } else if (!["reject", "revoke"].includes(action))
    throw new ApiError(400, "未知的审批操作");
  return db().$transaction(async (tx) => {
    const updated = await tx.node.updateMany({
      where: { id, status: node.status },
      data: {
        ...certificate,
        status:
          action === "approve"
            ? "APPROVED"
            : action === "reject"
              ? "REJECTED"
              : "REVOKED",
        approvedById: actor.userId,
        approvedAt: new Date(),
      },
    });
    if (!updated.count) throw new ApiError(409, "节点状态已经变更");
    await tx.auditEvent.create({
      data: {
        actorId: actor.userId,
        apiKeyId: actor.apiKeyId,
        action: `nodes.${action}`,
        resourceType: "Node",
        resourceId: id,
        nodeId: id,
      },
    });
    return { id, status: action };
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

/** Only authenticated mTLS connections call this; same-key renewal has a 24-hour delivery grace. */
export async function renewCertificate(nodeId: string, csrPem: string) {
  validateCsr(csrPem);
  return db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Node" WHERE id=${nodeId} FOR UPDATE`;
    const node = await tx.node.findUniqueOrThrow({ where: { id: nodeId } });
    if (
      node.status !== "APPROVED" ||
      node.csrPem !== csrPem ||
      !node.certificatePem
    )
      throw new ApiError(403, "证书轮换身份不匹配");
    const expires = new Date(
      new X509Certificate(node.certificatePem).validTo,
    ).getTime();
    // A lost reply is retried with the old certificate; return the already committed replacement.
    if (expires - Date.now() > 14 * 86400000)
      return { certificatePem: node.certificatePem };
    const issued = issueCertificate(nodeId, csrPem);
    await tx.node.update({
      where: { id: nodeId },
      data: {
        ...issued,
        previousCertificateFingerprint: node.certificateFingerprint,
        certificateRotatedAt: new Date(),
      },
    });
    await tx.auditEvent.create({
      data: {
        action: "nodes.certificate-renewed",
        resourceType: "Node",
        resourceId: nodeId,
        nodeId,
      },
    });
    return { certificatePem: issued.certificatePem };
  });
}
export function acceptsFingerprint(
  node: {
    certificateFingerprint: string | null;
    previousCertificateFingerprint: string | null;
    certificateRotatedAt: Date | null;
  },
  fingerprint: string,
) {
  return (
    node.certificateFingerprint === fingerprint ||
    (node.previousCertificateFingerprint === fingerprint &&
      !!node.certificateRotatedAt &&
      Date.now() - node.certificateRotatedAt.getTime() < 86400000)
  );
}
