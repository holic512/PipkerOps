/**
 * @file resources.ts
 * @project PipkerOps
 * @module stable-resource-service
 * @description 节点内持久资源登记、严格发现、共享应用关联与新操作的当前实例解析。
 * @logic 完整发现成功才替换实例；失败保留记录并标记过期；定位策略仅经用户确认变更，操作解析拒绝变化或歧义。
 * @dependencies Prisma, authorization, Docker direct service, resource discovery
 * @index_tags resources, identity, discovery, applications, audit
 * @author holic512
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, authorize, confirm, type Actor } from "../auth";
import { db } from "../db";
import {
  dockerContainerSchema,
  type DockerContainer,
} from "../docker-contracts";
import {
  locatorForContainer,
  matchResource,
  resourceFreshnessMs,
} from "../resource-discovery";
import {
  type ResourceMethod,
  type ResourceLocator,
} from "../resource-contracts";
import { executeDocker } from "./docker";

const include = {
  node: {
    select: {
      id: true,
      name: true,
      status: true,
      lastSeenAt: true,
      connectionError: true,
    },
  },
  applications: {
    include: { application: { select: { id: true, name: true } } },
  },
} as const;
const inspectSchema = z.object({
  Id: z.string().min(1),
  Name: z.string().min(1),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Status: z.string(), ExitCode: z.number().int() }),
});

export async function executeResource(
  actor: Actor,
  method: ResourceMethod,
  params: Record<string, unknown>,
) {
  if (method === "resources.list") {
    authorize(actor, "resources:read", params.nodeId as string | undefined);
    let resources = await db().resource.findMany({
      where: {
        ...(actor.apiKeyId && !actor.nodeIds?.includes("*")
          ? { nodeId: { in: actor.nodeIds ?? [] } }
          : {}),
        ...(params.nodeId ? { nodeId: params.nodeId as string } : {}),
        ...(params.type ? { type: params.type as string } : {}),
        ...(params.applicationId
          ? {
              applications: {
                some: { applicationId: params.applicationId as string },
              },
            }
          : {}),
      },
      include,
      orderBy: { createdAt: "desc" },
    });
    if (
      !actor.apiKeyId ||
      actor.scopes?.some((scope) => scope === "*" || scope === "docker:read")
    ) {
      const nodes = new Map<string, string>();
      for (const resource of resources)
        if (
          resource.strategy !== "unconfirmed" &&
          (!resource.lastAttemptedAt ||
            Date.now() - resource.lastAttemptedAt.getTime() >
              resourceFreshnessMs)
        )
          nodes.set(resource.nodeId, resource.id);
      if (nodes.size) {
        await Promise.all(
          [...nodes.values()].map((id) => discoverResource(actor, id)),
        );
        resources = await db().resource.findMany({
          where: { id: { in: resources.map((item) => item.id) } },
          include,
          orderBy: { createdAt: "desc" },
        });
      }
    }
    return resources
      .map(withFreshness)
      .filter(
        (resource) =>
          (!params.identification ||
            resource.identification === params.identification) &&
          (!params.runtimeState ||
            resource.runtimeState === params.runtimeState),
      );
  }
  if (
    method === "resources.preview" ||
    method === "resources.register" ||
    method === "resources.rebind"
  ) {
    const nodeId = params.nodeId as string;
    authorize(
      actor,
      method === "resources.preview" ? "resources:read" : "resources:write",
      nodeId,
    );
    if (method !== "resources.preview") confirm(params.confirmed);
    const old =
      method === "resources.rebind"
        ? await readResource(
            actor,
            params.resourceId as string,
            "resources:write",
          )
        : null;
    if (old && old.nodeId !== nodeId)
      throw new ApiError(400, "重新指定实例必须属于资源原节点");
    const preview = await previewResource(actor, params);
    if (method === "resources.preview") return preview;
    if (preview.duplicates.length)
      throw new ApiError(
        409,
        `该逻辑资源或当前实例已登记：${preview.duplicates.map((item) => item.name).join("、")}`,
      );
    if (preview.identification !== "LOCATED")
      throw new ApiError(409, "定位规则存在冲突，请先核对候选实例");
    if (params.strategy === "label" && params.persistenceConfirmed !== true)
      throw new ApiError(
        400,
        "请确认资源标签已保存在实际 Compose、docker run 脚本或部署配置中，重建时仍会携带",
      );
    const now = new Date();
    const resourceId = old?.id ?? randomUUID();
    const data = {
      ...preview.locator,
      name: (params.name as string | undefined) ?? old!.name,
      nodeId,
      identification: preview.identification,
      runtimeState: matchResource(preview.locator, preview.instances)
        .runtimeState,
      instances: preview.instances as never,
      discoveryError: null,
      lastDiscoveredAt: now,
      lastAttemptedAt: now,
      lastSeenAt: now,
    };
    try {
      return await db().$transaction(async (tx) => {
        const resource = old
          ? await tx.resource.update({
              where: { id: resourceId },
              data,
              include,
            })
          : await tx.resource.create({
              data: { id: resourceId, ...data },
              include,
            });
        await tx.auditEvent.create({
          data: auditData(actor, method, resourceId, nodeId, {
            locator: preview.locator,
            containerIds: preview.instances.map((item) => item.id),
            persistenceConfirmed: params.persistenceConfirmed === true,
          }),
        });
        return resource;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002")
        throw new ApiError(409, "该节点的定位规则已被登记，请使用已有资源");
      throw error;
    }
  }
  if (method === "resources.resolve")
    return resolveResource(
      actor,
      params.resourceId as string,
      params.expectedContainerId as string | undefined,
    );
  const writing = [
    "resources.update",
    "resources.associate",
    "resources.unlink",
  ].includes(method);
  const resource = await readResource(
    actor,
    params.resourceId as string,
    writing ? "resources:write" : "resources:read",
  );
  if (method === "resources.get") return withFreshness(resource);
  if (method === "resources.discover")
    return discoverResource(actor, resource.id);
  if (method === "resources.update") {
    return db().$transaction(async (tx) => {
      const changed = await tx.resource.update({
        where: { id: resource.id },
        data: { name: params.name as string },
        include,
      });
      await tx.auditEvent.create({
        data: auditData(actor, method, resource.id, resource.nodeId, {
          name: changed.name,
        }),
      });
      return changed;
    });
  }
  if (method === "resources.associate" || method === "resources.unlink") {
    authorize(actor, "apps:write", resource.nodeId);
    const applicationId = params.applicationId as string;
    if (method === "resources.unlink") confirm(params.confirmed);
    const application = await db().application.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) throw new ApiError(404, "应用不存在");
    return db().$transaction(async (tx) => {
      if (method === "resources.associate")
        await tx.applicationResource.upsert({
          where: {
            applicationId_resourceId: {
              applicationId,
              resourceId: resource.id,
            },
          },
          update: {},
          create: { applicationId, resourceId: resource.id },
        });
      else {
        await tx.applicationResource.deleteMany({
          where: { applicationId, resourceId: resource.id },
        });
        const legacy = await tx.deployment.findMany({
          where: { applicationId, resourceId: resource.id },
          select: { id: true },
        });
        await tx.probe.deleteMany({
          where: {
            id: { in: legacy.map((item) => `deployment-health:${item.id}`) },
          },
        });
        await tx.deployment.deleteMany({
          where: { applicationId, resourceId: resource.id },
        });
      }
      await tx.auditEvent.create({
        data: auditData(actor, method, resource.id, resource.nodeId, {
          applicationId,
        }),
      });
      return tx.resource.findUniqueOrThrow({
        where: { id: resource.id },
        include,
      });
    });
  }
  throw new ApiError(400, "不支持的资源方法");
}

export async function resolveResource(
  actor: Actor,
  resourceId: string,
  expectedContainerId?: string,
) {
  const resource = await discoverResource(actor, resourceId);
  if (resource.identification !== "LOCATED")
    throw new ApiError(
      409,
      `资源当前无法明确定位（${resource.identification}），请在资源页面核对定位规则`,
    );
  const instances = dockerContainerSchema.array().parse(resource.instances);
  const selected = expectedContainerId
    ? instances.find((item) => item.id === expectedContainerId)
    : instances.length === 1
      ? instances[0]
      : undefined;
  if (!selected)
    throw new ApiError(
      409,
      expectedContainerId
        ? "容器实例已变化，请刷新资源并重新确认当前实例"
        : "服务包含多个容器实例，请明确选择本次操作实例",
    );
  return { ...resource, containerId: selected.id };
}

export async function discoverResource(actor: Actor, resourceId: string) {
  const resource = await readResource(actor, resourceId, "resources:read");
  if (resource.strategy === "unconfirmed") return resource;
  authorize(actor, "docker:read", resource.nodeId);
  await db().resource.updateMany({
    where: { nodeId: resource.nodeId, strategy: { not: "unconfirmed" } },
    data: { lastAttemptedAt: new Date() },
  });
  try {
    const containers = await collectContainers(actor, resource.nodeId);
    const now = new Date();
    // One complete node snapshot updates every existing rule from the same source.
    const resources = await db().resource.findMany({
      where: { nodeId: resource.nodeId, strategy: { not: "unconfirmed" } },
    });
    await db().$transaction(
      resources.map((item) => {
        const matched = matchResource(item as ResourceLocator, containers);
        return db().resource.update({
          where: { id: item.id },
          data: {
            ...matched,
            instances: matched.instances as never,
            lastDiscoveredAt: now,
            ...(matched.instances.length ? { lastSeenAt: now } : {}),
            discoveryError: null,
          },
        });
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "资源采集失败";
    await db().resource.updateMany({
      where: { nodeId: resource.nodeId, strategy: { not: "unconfirmed" } },
      data: { identification: "STALE", discoveryError: message },
    });
  }
  return db().resource.findUniqueOrThrow({
    where: { id: resource.id },
    include,
  });
}

async function previewResource(actor: Actor, params: Record<string, unknown>) {
  const containers = await collectContainers(actor, params.nodeId as string);
  const selected = containers.find((item) => item.id === params.containerId);
  if (!selected)
    throw new ApiError(409, "选中的完整容器 ID 已不存在，请刷新容器列表");
  const locator = locatorForContainer(
    params.strategy as "compose" | "label" | "name",
    selected,
  );
  if (locator.strategy === "compose" && (!locator.project || !locator.service))
    throw new ApiError(400, "该容器缺少明确的 Compose 项目或服务标签");
  if (locator.strategy === "label" && !locator.labelValue)
    throw new ApiError(
      400,
      "容器尚未携带 pipkerops.resource-id；请先审查并保存部署配置，再自行重建或选择固定名称定位",
    );
  for (const key of [
    "project",
    "service",
    "containerName",
    "labelValue",
  ] as const)
    if (params[key] !== undefined && params[key] !== locator[key])
      throw new ApiError(409, "定位规则与当前实例不一致，请刷新后重新核对");
  const matched = matchResource(locator, containers);
  const existing = await db().resource.findMany({
    where: {
      nodeId: params.nodeId as string,
      ...(params.resourceId
        ? { id: { not: params.resourceId as string } }
        : {}),
    },
  });
  const candidates = new Set(matched.instances.map((item) => item.id));
  const duplicates = existing
    .filter(
      (item) =>
        item.locatorKey === locator.locatorKey ||
        matchResource(item as ResourceLocator, containers).instances.some(
          (instance) => candidates.has(instance.id),
        ) ||
        (item.strategy === "unconfirmed" &&
          matched.instances.some((instance) => {
            const legacy = (item.metadata as { legacyTarget?: string })
              .legacyTarget;
            return (
              legacy === instance.id ||
              legacy === instance.name ||
              legacy === `/${instance.name}`
            );
          })),
    )
    .map(({ id, name }) => ({ id, name }));
  return {
    locator,
    selected,
    instances: matched.instances,
    identification: matched.identification,
    duplicates,
  };
}

async function collectContainers(
  actor: Actor,
  nodeId: string,
): Promise<DockerContainer[]> {
  const listed = (await executeDocker(actor, "docker.list", { nodeId })) as {
    containers: DockerContainer[];
  };
  const containers: DockerContainer[] = [];
  // Agent queries share four execution slots with operations; inspect sequentially.
  for (const container of listed.containers) {
    const inspected = (await executeDocker(actor, "docker.inspect", {
      nodeId,
      id: container.id,
    })) as { containers: unknown[] };
    if (inspected.containers.length !== 1)
      throw new ApiError(502, "容器发现不完整：inspect 未返回唯一实例");
    const detail = inspectSchema.parse(inspected.containers[0]);
    if (detail.Id !== container.id)
      throw new ApiError(502, "容器发现身份不一致");
    containers.push({
      ...container,
      name: detail.Name.replace(/^\//, ""),
      labels: detail.Config.Labels ?? {},
      state: detail.State.Status,
      exitCode: detail.State.ExitCode,
    });
  }
  return containers;
}

async function readResource(actor: Actor, resourceId: string, scope: string) {
  authorize(actor, scope);
  const resource = await db().resource.findUnique({
    where: { id: resourceId },
    include,
  });
  if (!resource) throw new ApiError(404, "资源不存在");
  authorize(actor, scope, resource.nodeId);
  return resource;
}

function withFreshness<
  T extends {
    identification: string;
    lastDiscoveredAt: Date | null;
    node: {
      status: string;
      lastSeenAt: Date | null;
      connectionError: string | null;
    };
  },
>(resource: T) {
  return resource.identification !== "UNCONFIRMED" &&
    resource.identification !== "STALE" &&
    (!resource.lastDiscoveredAt ||
      Date.now() - resource.lastDiscoveredAt.getTime() > resourceFreshnessMs ||
      resource.node.status !== "APPROVED" ||
      !!resource.node.connectionError ||
      !resource.node.lastSeenAt ||
      Date.now() - resource.node.lastSeenAt.getTime() > resourceFreshnessMs)
    ? { ...resource, identification: "STALE" }
    : resource;
}

function auditData(
  actor: Actor,
  action: string,
  resourceId: string,
  nodeId: string,
  detail: object,
) {
  return {
    actorId: actor.userId,
    apiKeyId: actor.apiKeyId,
    action,
    resourceType: "Resource",
    resourceId,
    nodeId,
    detail: detail as never,
  };
}
