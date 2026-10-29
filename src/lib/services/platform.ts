/**
 * @file platform.ts
 * @project PipkerOps
 * @module business-api
 * @description Web 与 MCP 共用的资源服务入口，显式路由业务方法与输入契约。
 * @logic 查询执行scope/节点过滤，任务可按计划关联筛选；写入审计，远端操作统一转换为持久任务。
 * @dependencies Prisma, authorization, node/task services, cron-parser
 * @index_tags api, apps, probes, topology, automation
 * @author holic512
 */
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db";
import { ApiError, authorize, confirm, nodeFilter, type Actor } from "../auth";
import { randomToken, hashToken } from "../crypto";
import * as nodes from "./nodes";
import { metricDetails } from "./metric-details";
import { createTask, validateTask, listTasks, getTask } from "./tasks";
import { redis } from "../redis";
import { privateHost } from "../config";
const id = z.string().min(1).max(100);
export { METHODS, mutation } from "./contracts";
import { methodSchemas } from "./contracts";
function nodeWhere(actor: Actor) {
  return actor.apiKeyId && !actor.nodeIds?.includes("*")
    ? { nodeId: { in: actor.nodeIds ?? [] } }
    : {};
}
function can(actor: Actor, scope: string) {
  try {
    authorize(actor, scope);
    return true;
  } catch {
    return false;
  }
}
function probeWhere(actor: Actor) {
  return actor.apiKeyId && !actor.nodeIds?.includes("*")
    ? {
        OR: [
          { sourceNodeId: null },
          { sourceNodeId: { in: actor.nodeIds ?? [] } },
        ],
      }
    : {};
}
function alertWhere(actor: Actor) {
  return actor.apiKeyId && !actor.nodeIds?.includes("*")
    ? {
        OR: [
          { nodeId: { in: actor.nodeIds ?? [] } },
          { probe: { is: probeWhere(actor) } },
        ],
      }
    : {};
}
function notificationWhere(actor: Actor) {
  return {
    AND: [
      { OR: [{ userId: null }, { userId: actor.userId }] },
      ...(actor.apiKeyId ? [{ alertRule: { is: alertWhere(actor) } }] : []),
    ],
  };
}
async function audit(
  actor: Actor,
  action: string,
  type: string,
  resourceId: string,
) {
  await db().auditEvent.create({
    data: {
      actorId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action,
      resourceType: type,
      resourceId,
    },
  });
}
export function validateProbeTarget(type: string, target: string) {
  if (type === "HTTP") {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new ApiError(400, "无效的 HTTP 探测地址");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      ["169.254.169.254", "metadata.google.internal"].includes(url.hostname) ||
      (url.protocol === "http:" && !privateHost(url.hostname))
    )
      throw new ApiError(400, "无效的 HTTP 探测地址");
  } else if (
    !/^([a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(target) ||
    Number(target.slice(target.lastIndexOf(":") + 1)) > 65535 ||
    Number(target.slice(target.lastIndexOf(":") + 1)) < 1
  )
    throw new ApiError(400, "TCP 目标格式必须为 host:port");
}
export async function execute(
  actor: Actor,
  method: string,
  input: unknown = {},
): Promise<unknown> {
  if (!Object.hasOwn(methodSchemas, method))
    throw new ApiError(404, "未知业务方法");
  const schema = methodSchemas[method as keyof typeof methodSchemas];
  const p = schema.passthrough().parse(input);
  switch (method) {
    case "users.me":
      return db().user.findUnique({
        where: { id: actor.userId },
        select: { id: true, email: true, displayName: true, role: true },
      });
    case "nodes.update": {
      const data = methodSchemas["nodes.update"].parse(p);
      authorize(actor, "nodes:write", data.id);
      await db().node.update({
        where: { id: data.id },
        data: { name: data.name, labels: data.labels },
      });
      await audit(actor, method, "Node", data.id);
      return { id: data.id };
    }
    case "nodes.list":
      return nodes.listNodes(actor);
    case "nodes.token":
      return nodes.enrollmentToken(actor, p);
    case "nodes.approve":
    case "nodes.reject":
    case "nodes.revoke":
      confirm(p.confirmed);
      return nodes.changeNode(actor, id.parse(p.id), method.split(".")[1]);
    case "nodes.metrics":
      return nodes.metrics(
        actor,
        id.parse(p.nodeId),
        p.hours ? z.number().parse(p.hours) : 24,
      );
    case "nodes.history": {
      const data = p as z.infer<(typeof methodSchemas)["nodes.history"]>;
      return metricDetails(
        actor,
        data.nodeId,
        data.kind,
        data.hours,
        data.device,
      );
    }
    case "tasks.create":
      return createTask(actor, p, actor.apiKeyId ? "MCP" : "WEB");
    case "tasks.list":
      return listTasks(actor, p.scheduleId as string | undefined);
    case "tasks.get":
      return getTask(actor, id.parse(p.id));
    case "tasks.cancel": {
      const t = await getTask(actor, id.parse(p.id));
      authorize(actor, "tasks:write", t.nodeId ?? undefined);
      confirm(p.confirmed);
      const changed = await db().task.updateMany({
        where: { id: t.id, status: "QUEUED" },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
      if (!changed.count) throw new ApiError(409, "只能取消尚未分发的任务");
      await audit(actor, method, "Task", t.id);
      return { id: t.id, status: "CANCELLED" };
    }
    case "overview": {
      authorize(actor, "nodes:read");
      const where = nodeFilter(actor);
      const [total, approved, pending, recent, taskCounts] = await Promise.all([
        db().node.count({ where }),
        db().node.count({
          where: {
            ...where,
            status: "APPROVED",
            lastSeenAt: { gte: new Date(Date.now() - 60000) },
          },
        }),
        db().node.count({ where: { ...where, status: "PENDING" } }),
        db().node.findMany({
          where,
          omit: {
            csrPem: true,
            certificatePem: true,
            certificateFingerprint: true,
            previousCertificateFingerprint: true,
          },
          include: { metrics: { take: 1, orderBy: { recordedAt: "desc" } } },
          take: 50,
          orderBy: { createdAt: "desc" },
        }),
        can(actor, "tasks:read")
          ? db().task.groupBy({
              by: ["status"],
              where: nodeWhere(actor),
              _count: true,
            })
          : Promise.resolve([]),
      ]);
      return {
        total,
        online: approved,
        pending,
        offline: total - approved - pending,
        nodes: recent.map((n) => ({
          ...n,
          connected:
            n.status === "APPROVED" &&
            !!n.lastSeenAt &&
            Date.now() - n.lastSeenAt.getTime() < 60000,
        })),
        tasks: taskCounts,
        generatedAt: new Date(),
      };
    }
    case "applications.list":
      authorize(actor, "apps:read");
      return db().application.findMany({
        include: {
          deployments: {
            where: nodeWhere(actor),
            include: {
              node: { select: { id: true, name: true, lastSeenAt: true } },
            },
          },
          probes: {
            where: can(actor, "probes:read")
              ? probeWhere(actor)
              : { id: { in: [] } },
            select: {
              id: true,
              name: true,
              status: true,
              enabled: true,
              results: {
                take: 1,
                orderBy: { recordedAt: "desc" },
                select: {
                  recordedAt: true,
                  data: true,
                  success: true,
                  latencyMs: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    case "applications.save": {
      authorize(actor, "apps:write");
      const data = methodSchemas["applications.save"].parse(p);
      const { id: appId, ...fields } = data;
      const app = appId
        ? await db().application.update({
            where: { id: appId },
            data: fields as never,
          })
        : await db().application.create({ data: fields as never });
      await audit(actor, method, "Application", app.id);
      return app;
    }
    case "applications.delete": {
      authorize(actor, "apps:write", undefined, true);
      confirm(p.confirmed);
      const appId = id.parse(p.id);
      await db().$transaction(async (tx) => {
        const deployments = await tx.deployment.findMany({
          where: { applicationId: appId },
          select: { id: true, nodeId: true },
        });
        for (const deployment of deployments)
          authorize(actor, "apps:write", deployment.nodeId, true);
        await tx.probe.deleteMany({
          where: {
            id: { in: deployments.map((d) => `deployment-health:${d.id}`) },
          },
        });
        await tx.application.delete({ where: { id: appId } });
      });
      await audit(actor, method, "Application", appId);
      return { id: appId };
    }
    case "deployments.save": {
      const d = methodSchemas["deployments.save"].parse(p);
      authorize(actor, "apps:write", d.nodeId);
      if (d.id) {
        const old = await db().deployment.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "部署不存在");
        authorize(actor, "apps:write", old.nodeId);
      }
      if (d.healthUrl) {
        authorize(actor, "probes:write", d.nodeId);
        validateProbeTarget("HTTP", d.healthUrl);
      }
      const { id: deploymentId, ...data } = d;
      const deployment = await db().$transaction(async (tx) => {
        const resource = deploymentId
          ? await tx.deployment.update({
              where: { id: deploymentId },
              data: data as never,
            })
          : await tx.deployment.create({ data: data as never });
        if (d.healthUrl) {
          const config = {
            createdById: actor.userId,
            createdByApiKeyId: actor.apiKeyId ?? null,
            name: `实例健康 · ${d.name}`,
            type: "HTTP" as const,
            target: d.healthUrl,
            applicationId: d.applicationId,
            sourceNodeId: d.nodeId,
            intervalSeconds: 60,
            timeoutMs: 5000,
            failureThreshold: 3,
            enabled: true,
            nextRunAt: new Date(),
          };
          await tx.probe.upsert({
            where: { id: `deployment-health:${resource.id}` },
            create: { id: `deployment-health:${resource.id}`, ...config },
            update: config,
          });
        } else if (d.healthUrl === null)
          await tx.probe.deleteMany({
            where: { id: `deployment-health:${resource.id}` },
          });
        await tx.auditEvent.create({
          data: {
            actorId: actor.userId,
            apiKeyId: actor.apiKeyId,
            action: method,
            resourceType: "Deployment",
            resourceId: resource.id,
            nodeId: resource.nodeId,
          },
        });
        return resource;
      });
      return deployment;
    }
    case "deployments.delete": {
      const resource = await db().deployment.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!resource) throw new ApiError(404, "实例不存在");
      authorize(actor, "apps:write", resource.nodeId, true);
      confirm(p.confirmed);
      await db().$transaction(async (tx) => {
        await tx.probe.deleteMany({
          where: { id: `deployment-health:${resource.id}` },
        });
        await tx.deployment.delete({ where: { id: resource.id } });
      });
      await audit(actor, method, "Deployment", resource.id);
      return { id: resource.id };
    }
    case "dependencies.delete": {
      authorize(actor, "apps:write", undefined, true);
      confirm(p.confirmed);
      const resourceId = id.parse(p.id);
      await db().dependency.delete({ where: { id: resourceId } });
      await audit(actor, method, "Dependency", resourceId);
      return { id: resourceId };
    }
    case "dependencies.save": {
      authorize(actor, "apps:write");
      const d = methodSchemas["dependencies.save"].parse(p);
      if (d.fromApplicationId === d.toApplicationId)
        throw new ApiError(400, "应用不能依赖自身");
      const result = await db().dependency.upsert({
        where: {
          fromApplicationId_toApplicationId_type: {
            fromApplicationId: d.fromApplicationId,
            toApplicationId: d.toApplicationId,
            type: d.type,
          },
        },
        create: d,
        update: { description: d.description },
      });
      await audit(actor, method, "Dependency", result.id);
      return result;
    }
    case "probes.list": {
      authorize(actor, "probes:read");
      return db().probe.findMany({
        where: probeWhere(actor),
        include: {
          sourceNode: { select: { id: true, name: true } },
          results: { take: 1, orderBy: { recordedAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      });
    }
    case "probes.save": {
      const d = methodSchemas["probes.save"].omit({ confirmed: true }).parse(p);
      authorize(actor, "probes:write", d.sourceNodeId ?? undefined);
      validateProbeTarget(d.type, d.target);
      if (d.id) {
        const old = await db().probe.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "探针不存在");
        authorize(actor, "probes:write", old.sourceNodeId ?? undefined);
      }
      const mutating =
        d.type === "HTTP" &&
        !["GET", "HEAD", "OPTIONS"].includes(String(d.config.method ?? "GET"));
      if (mutating) {
        authorize(actor, "probes:write", d.sourceNodeId ?? undefined, true);
        confirm(p.confirmed);
      }
      const { id: probeId, ...fields } = d;
      const data = {
        ...fields,
        createdById: actor.userId,
        createdByApiKeyId: actor.apiKeyId ?? null,
      };
      const result = probeId
        ? await db().probe.update({
            where: { id: probeId },
            data: { ...data, nextRunAt: new Date() } as never,
          })
        : await db().probe.create({
            data: { ...data, nextRunAt: new Date() } as never,
          });
      await audit(actor, method, "Probe", result.id);
      return result;
    }
    case "probes.run": {
      const probe = await db().probe.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!probe) throw new ApiError(404, "探针不存在");
      return createTask(
        actor,
        {
          confirmed: p.confirmed,
          type: "probe.run",
          nodeId: probe.sourceNodeId ?? undefined,
          payload: {
            probeId: probe.id,
            type: probe.type,
            target: probe.target,
            timeoutMs: probe.timeoutMs,
            config: probe.config,
            mapping: probe.mapping,
          },
        },
        actor.apiKeyId ? "MCP" : "WEB",
      );
    }
    case "probes.history": {
      authorize(actor, "probes:read");
      const probe = await db().probe.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!probe) throw new ApiError(404, "探针不存在");
      authorize(actor, "probes:read", probe.sourceNodeId ?? undefined);
      const results = await db().probeResult.findMany({
        where: { probeId: probe.id },
        orderBy: { recordedAt: "desc" },
        take: 500,
      });
      return {
        results,
        successRate: results.length
          ? results.filter((r) => r.success).length / results.length
          : null,
        averageLatencyMs: results.length
          ? results.reduce((s, r) => s + r.latencyMs, 0) / results.length
          : null,
      };
    }
    case "probes.delete": {
      confirm(p.confirmed);
      const probe = await db().probe.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!probe) throw new ApiError(404, "探针不存在");
      authorize(actor, "probes:write", probe.sourceNodeId ?? undefined);
      await db().probe.delete({ where: { id: probe.id } });
      await audit(actor, method, "Probe", probe.id);
      return { id: probe.id };
    }
    case "topology": {
      authorize(actor, "apps:read");
      authorize(actor, "nodes:read");
      const [applications, nodeList, dependencies, probes, sites] =
        await Promise.all([
          db().application.findMany({
            include: { deployments: { where: nodeWhere(actor) } },
          }),
          nodes.listNodes(actor),
          db().dependency.findMany(),
          can(actor, "probes:read")
            ? db().probe.findMany({ where: probeWhere(actor) })
            : Promise.resolve([]),
          can(actor, "sites:read")
            ? db().site.findMany({ where: nodeWhere(actor) })
            : Promise.resolve([]),
        ]);
      return { applications, nodes: nodeList, dependencies, probes, sites };
    }
    case "sites.list":
      authorize(actor, "sites:read");
      return db().site.findMany({
        where: nodeWhere(actor),
        include: { node: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      });
    case "sites.save": {
      const d = methodSchemas["sites.save"].parse(p);
      authorize(actor, "sites:write", d.nodeId);
      if (d.id) {
        const old = await db().site.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "站点不存在");
        authorize(actor, "sites:write", old.nodeId);
      }
      const { id: siteId, ...fields } = d;
      const url = new URL(d.upstream);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new ApiError(400, "上游必须是 HTTP/HTTPS");
      const data = {
        ...fields,
        config:
          fields.config ||
          `server {\n    listen 80;\n    server_name ${d.domain};\n    location ^~ /.well-known/acme-challenge/ { root /var/lib/pipkerops/acme; default_type text/plain; try_files $uri =404; }\n    location / {\n        proxy_pass ${url.href};\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}\n`,
        status: "DRAFT",
      };
      const site = siteId
        ? await db().site.update({ where: { id: siteId }, data })
        : await db().site.create({ data });
      await audit(actor, method, "Site", site.id);
      return site;
    }
    case "sites.delete": {
      const site = await db().site.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!site) throw new ApiError(404, "站点不存在");
      return createTask(actor, {
        type: "nginx.remove",
        nodeId: site.nodeId,
        payload: { domain: site.domain },
        confirmed: p.confirmed,
      });
    }
    case "sites.apply": {
      const site = await db().site.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!site) throw new ApiError(404, "站点不存在");
      const task = await createTask(actor, {
        type: "nginx.apply",
        nodeId: site.nodeId,
        payload: { domain: site.domain, config: site.config },
        confirmed: p.confirmed,
      });
      return task;
    }
    case "sites.certificate":
    case "sites.acme":
    case "sites.renew":
    case "sites.https": {
      const site = await db().site.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!site) throw new ApiError(404, "站点不存在");
      if (method === "sites.https") {
        authorize(actor, "sites:write", site.nodeId, true);
        confirm(p.confirmed);
        if (p.autoRenew !== false)
          authorize(actor, "schedules:write", site.nodeId, true);
        if (
          !site.certificateExpiresAt ||
          site.certificateExpiresAt <= new Date()
        )
          throw new ApiError(409, "请先签发或检查有效的生产证书");
        const domain = z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/)
          .parse(site.domain);
        const config = `server {\n    listen 80;\n    server_name ${domain};\n    location ^~ /.well-known/acme-challenge/ { root /var/lib/pipkerops/acme; default_type text/plain; try_files $uri =404; }\n    location / { return 301 https://$host$request_uri; }\n}\nserver {\n    listen 443 ssl;\n    server_name ${domain};\n    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    location / { proxy_pass ${new URL(site.upstream).href}; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }\n}\n`;
        const task = await createTask(actor, {
          type: "nginx.apply",
          nodeId: site.nodeId,
          payload: { domain, config },
          confirmed: true,
        });
        await db().site.update({
          where: { id: site.id },
          data: { config, status: "DRAFT" },
        });
        // Persistent automation keeps its creator and is reauthorized on every run.
        if (p.autoRenew !== false) {
          authorize(actor, "schedules:write", site.nodeId, true);
          const scheduleId = `site-renew:${site.id}`;
          const renewal = {
            name: `证书续期 · ${site.domain}`,
            cron: "17 3 * * *",
            timezone: "Asia/Shanghai",
            taskType: "nginx.renew",
            nodeId: site.nodeId,
            payload: { domain: site.domain, staging: false },
            createdById: actor.userId,
            createdByApiKeyId: actor.apiKeyId ?? null,
            enabled: true,
            nextRunAt: CronExpressionParser.parse("17 3 * * *", {
              tz: "Asia/Shanghai",
            })
              .next()
              .toDate(),
          };
          await db().schedule.upsert({
            where: { id: scheduleId },
            create: { id: scheduleId, ...renewal },
            update: renewal,
          });
          await audit(actor, "sites.auto-renew", "Schedule", scheduleId);
        }
        return task;
      }
      const type =
        method === "sites.certificate"
          ? "nginx.certificate"
          : method === "sites.acme"
            ? "nginx.acme"
            : "nginx.renew";
      return createTask(actor, {
        type,
        nodeId: site.nodeId,
        payload:
          method === "sites.renew"
            ? { domain: site.domain, staging: p.staging ?? false }
            : {
                domain: site.domain,
                staging: p.staging ?? false,
                ...(method === "sites.acme" ? { email: p.email } : {}),
              },
        confirmed: p.confirmed,
      });
    }
    case "keys.list":
      authorize(actor, "keys:write");
      return db().apiKey.findMany({
        where: actor.apiKeyId ? { id: actor.apiKeyId } : {},
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          nodeIds: true,
          allowDangerous: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
    case "keys.create": {
      authorize(actor, "keys:write", undefined, true);
      confirm(p.confirmed);
      if (actor.apiKeyId) throw new ApiError(403, "API Key 不能创建新的密钥");
      const d = methodSchemas["keys.create"].parse(p);
      const token = "pko_" + randomToken();
      const key = await db().apiKey.create({
        data: {
          name: d.name,
          scopes: d.scopes,
          nodeIds: d.nodeIds,
          allowDangerous: d.allowDangerous,
          expiresAt: new Date(Date.now() + d.days * 86400000),
          userId: actor.userId,
          keyHash: hashToken(token),
          keyPrefix: token.slice(0, 12),
        },
      });
      await audit(actor, method, "ApiKey", key.id);
      return { id: key.id, key: token };
    }
    case "keys.revoke": {
      authorize(actor, "keys:write");
      confirm(p.confirmed);
      const keyId = id.parse(p.id);
      if (actor.apiKeyId && actor.apiKeyId !== keyId)
        throw new ApiError(403, "API Key 只能吊销自身");
      const key = await db().apiKey.update({
        where: { id: keyId },
        data: { revokedAt: new Date() },
      });
      await audit(actor, method, "ApiKey", key.id);
      return { id: key.id };
    }
    case "audit.list":
      authorize(actor, "admin:write");
      return db().auditEvent.findMany({
        where: actor.apiKeyId
          ? {
              OR: [
                {
                  nodeId: {
                    in: actor.nodeIds?.includes("*")
                      ? undefined
                      : (actor.nodeIds ?? []),
                  },
                },
                { nodeId: null, apiKeyId: actor.apiKeyId },
              ],
            }
          : {},
        take: 200,
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { displayName: true } } },
      });
    case "notifications.list":
      authorize(actor, "alerts:read");
      return db().notification.findMany({
        where: notificationWhere(actor),
        take: 100,
        orderBy: { createdAt: "desc" },
      });
    case "notifications.read": {
      authorize(actor, "alerts:read");
      return db().notification.updateMany({
        where: {
          id: id.parse(p.id),
          ...notificationWhere(actor),
        },
        data: { readAt: new Date() },
      });
    }
    case "alerts.list":
      authorize(actor, "alerts:read");
      return db().alertRule.findMany({
        where: alertWhere(actor),
        orderBy: { createdAt: "desc" },
      });
    case "alerts.save": {
      const d = methodSchemas["alerts.save"].parse(p);
      authorize(actor, "alerts:write", d.nodeId);
      if (
        d.metric === "probeFailure"
          ? !d.probeId || !!d.nodeId
          : !d.nodeId || !!d.probeId
      )
        throw new ApiError(400, "节点指标只选择节点；探针失败指标只选择探针");
      if (d.probeId) {
        const probe = await db().probe.findUnique({ where: { id: d.probeId } });
        if (!probe) throw new ApiError(404, "探针不存在");
        authorize(actor, "alerts:write", probe.sourceNodeId ?? undefined);
      }
      const { id: ruleId, ...fields } = d;
      if (ruleId) {
        const old = await db().alertRule.findUnique({ where: { id: ruleId } });
        if (!old) throw new ApiError(404, "规则不存在");
        authorize(actor, "alerts:write", old.nodeId ?? undefined);
        if (old.probeId) {
          const probe = await db().probe.findUniqueOrThrow({
            where: { id: old.probeId },
          });
          authorize(actor, "alerts:write", probe.sourceNodeId ?? undefined);
        }
      }
      const rule = ruleId
        ? await db().alertRule.update({
            where: { id: ruleId },
            data: {
              ...fields,
              nodeId: fields.nodeId ?? null,
              probeId: fields.probeId ?? null,
              webhookUrl: fields.webhookUrl ?? null,
            },
          })
        : await db().alertRule.create({ data: fields });
      await audit(actor, method, "AlertRule", rule.id);
      return rule;
    }
    case "alerts.delete": {
      confirm(p.confirmed);
      const resource = await db().alertRule.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!resource) throw new ApiError(404, "规则不存在");
      authorize(actor, "alerts:write", resource.nodeId ?? undefined);
      if (resource.probeId) {
        const probe = await db().probe.findUniqueOrThrow({
          where: { id: resource.probeId },
        });
        authorize(actor, "alerts:write", probe.sourceNodeId ?? undefined);
      }
      await db().alertRule.delete({ where: { id: resource.id } });
      await audit(actor, method, "AlertRule", resource.id);
      return { id: resource.id };
    }
    case "schedules.list":
      authorize(actor, "schedules:read");
      return db().schedule.findMany({
        where: nodeWhere(actor),
        orderBy: { createdAt: "desc" },
      });
    case "schedules.save": {
      authorize(actor, "schedules:write");

      const d = methodSchemas["schedules.save"].parse(p);
      authorize(actor, "schedules:write", d.nodeId);
      confirm(d.confirmed);
      const validated = await validateTask(actor, {
        type: d.taskType,
        nodeId: d.nodeId,
        payload: d.payload,
        confirmed: d.confirmed,
      });
      let nextRunAt: Date;
      try {
        nextRunAt = CronExpressionParser.parse(d.cron, { tz: d.timezone })
          .next()
          .toDate();
      } catch {
        throw new ApiError(400, "Cron 表达式或时区无效");
      }
      if (d.id) {
        const old = await db().schedule.findUnique({ where: { id: d.id } });
        if (!old) throw new ApiError(404, "计划不存在");
        authorize(actor, "schedules:write", old.nodeId ?? undefined);
      }
      const data = {
        enabled: d.enabled,
        name: d.name,
        cron: d.cron,
        timezone: d.timezone,
        taskType: d.taskType,
        nodeId: d.nodeId ?? null,
        payload: validated.payload,
      };
      const fields = {
        ...data,
        payload: data.payload as never,
        nextRunAt,
        createdById: actor.userId,
        createdByApiKeyId: actor.apiKeyId ?? null,
      };
      const s = d.id
        ? await db().schedule.update({ where: { id: d.id }, data: fields })
        : await db().schedule.create({ data: fields });
      await audit(actor, method, "Schedule", s.id);
      return s;
    }
    case "schedules.delete": {
      authorize(actor, "schedules:write");
      confirm(p.confirmed);
      const s = await db().schedule.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!s) throw new ApiError(404, "计划不存在");
      authorize(actor, "schedules:write", s.nodeId ?? undefined);
      await db().schedule.delete({ where: { id: s.id } });
      await audit(actor, method, "Schedule", s.id);
      return { id: s.id };
    }
    case "actions.list":
      authorize(actor, "actions:read");
      return db().customAction.findMany({ orderBy: { createdAt: "desc" } });
    case "actions.save": {
      authorize(actor, "actions:write", undefined, true);
      confirm(p.confirmed);
      const d = methodSchemas["actions.save"]
        .omit({ confirmed: true })
        .parse(p);
      for (const n of d.nodeIds) authorize(actor, "actions:write", n, true);
      const { id: actionId, ...data } = d;
      if (actionId) {
        const old = await db().customAction.findUnique({
          where: { id: actionId },
        });
        if (!old) throw new ApiError(404, "操作不存在");
        for (const node of old.nodeIds)
          authorize(actor, "actions:write", node, true);
      }
      const fields = {
        ...data,
        config: data.config as never,
        parameters: data.parameters,
        dangerous: data.type !== "URL",
        createdById: actor.userId,
      };
      const a = actionId
        ? await db().customAction.update({
            where: { id: actionId },
            data: fields,
          })
        : await db().customAction.create({ data: fields });
      await audit(actor, method, "CustomAction", a.id);
      return a;
    }
    case "actions.delete": {
      confirm(p.confirmed);
      const action = await db().customAction.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!action) throw new ApiError(404, "操作不存在");
      authorize(actor, "actions:write", undefined, true);
      for (const node of action.nodeIds)
        authorize(actor, "actions:write", node, true);
      await db().customAction.delete({ where: { id: action.id } });
      await audit(actor, method, "CustomAction", action.id);
      return { id: action.id };
    }
    case "actions.run": {
      const a = await db().customAction.findUnique({
        where: { id: id.parse(p.id) },
      });
      if (!a) throw new ApiError(404, "动作不存在");
      const nodeId = p.nodeId ? id.parse(p.nodeId) : undefined;
      authorize(actor, "actions:write", nodeId, a.dangerous);
      if (a.dangerous) confirm(p.confirmed);
      if (a.nodeIds.length && (!nodeId || !a.nodeIds.includes(nodeId)))
        throw new ApiError(403, "动作不允许此节点");
      const values = z
        .record(z.string(), z.string().max(4000))
        .parse(p.values ?? {});
      const parameters = z
        .array(z.object({ name: z.string(), required: z.boolean() }))
        .parse(a.parameters);
      for (const field of parameters)
        if (field.required && !values[field.name])
          throw new ApiError(400, `缺少参数 ${field.name}`);
      const config = { ...(a.config as Record<string, unknown>) };
      for (const [key, value] of Object.entries(config))
        if (typeof value === "string")
          config[key] = value.replace(
            /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
            (_, n) => {
              if (!(n in values)) throw new ApiError(400, `缺少参数 ${n}`);
              return a.type === "shell.exec"
                ? "'" + values[n].replaceAll("'", "'\\''") + "'"
                : values[n];
            },
          );
      if (a.type === "URL") {
        const url = z.url().parse(config.url);
        if (!url.startsWith("https://"))
          throw new ApiError(400, "跳转地址必须是 HTTPS");
        await audit(actor, method, "CustomAction", a.id);
        return { url };
      }
      if (a.type === "HTTP")
        return createTask(
          actor,
          {
            type: "http.request",
            payload: config,
            confirmed: p.confirmed,
            idempotencyKey: p.idempotencyKey,
          },
          actor.apiKeyId ? "MCP" : "WEB",
        );
      return createTask(
        actor,
        {
          type: a.type,
          nodeId,
          payload: config,
          confirmed: p.confirmed,
          idempotencyKey: p.idempotencyKey,
        },
        actor.apiKeyId ? "MCP" : "WEB",
      );
    }
    case "terminal.ticket": {
      const nodeId = id.parse(p.nodeId);
      const containerId = p.containerId
        ? z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
            .parse(p.containerId)
        : undefined;
      authorize(actor, "terminal:write", nodeId, true);
      if (containerId) authorize(actor, "docker:write", nodeId, true);
      confirm(p.confirmed);
      const node = await db().node.findUnique({ where: { id: nodeId } });
      if (!node || node.status !== "APPROVED")
        throw new ApiError(409, "节点不可用");
      const ticket = randomToken();
      await (
        await redis()
      ).set(
        `pko:terminal:${hashToken(ticket)}`,
        JSON.stringify({ actor, nodeId, containerId }),
        { EX: 60 },
      );
      await audit(actor, method, "Node", nodeId);
      const url = new URL(
        process.env.ENROLL_PUBLIC_URL ?? "https://localhost:9444",
      );
      url.protocol = "wss:";
      url.pathname = "/terminal";
      url.searchParams.set("ticket", ticket);
      return { url: url.href };
    }
    default:
      throw new ApiError(404, "未知业务方法");
  }
}
