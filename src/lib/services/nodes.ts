/**
 * @file nodes.ts
 * @project PipkerOps
 * @module nodes
 * @description 节点注册、审批、吊销、指标查询的统一服务。
 * @logic 原子消费注册令牌；获批后签发绑定节点的证书；查询按 API Key 节点范围过滤。
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
  const data = z
    .object({
      name: z.string().min(1).max(120),
      maxUses: z.number().int().min(1).max(50).default(1),
      hours: z.number().min(1).max(168).default(24),
    })
    .parse(input);
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
  if (!Number.isFinite(hours) || hours < 1 || hours > 8760)
    throw new ApiError(400, "查询时间范围无效");
  const since = new Date(Date.now() - hours * 3600000);
  if (hours > 48)
    return {
      resolution: "hour",
      samples: await db().metricHourly.findMany({
        where: { nodeId, bucketAt: { gte: since } },
        orderBy: { bucketAt: "asc" },
        take: 9000,
      }),
    };
  return {
    resolution: "raw",
    samples: await db().metricSample.findMany({
      where: { nodeId, recordedAt: { gte: since } },
      orderBy: { recordedAt: "desc" },
      take: 3000,
    }),
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
