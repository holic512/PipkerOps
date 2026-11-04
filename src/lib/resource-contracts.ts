/**
 * @file resource-contracts.ts
 * @project PipkerOps
 * @module stable-resource-contracts
 * @description 持久资源登记、定位、共享关联及实例解析的 Web/MCP 契约。
 * @logic 平台身份与运行实例分离；登记和重新指定均要求明确确认定位规则。
 * @dependencies Zod, Docker contracts
 * @index_tags resources, identity, contracts, discovery
 * @author holic512
 */
import { z } from "zod";
import { dockerContainerSchema } from "./docker-contracts";

const resourceId = z.uuid();
const nodeId = z.string().min(1).max(100);
const applicationId = z.string().min(1).max(100);
const containerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const name = z.string().trim().min(1).max(100);
const reference = z.object({ resourceId });
const locator = z.object({
  nodeId,
  containerId,
  strategy: z.enum(["compose", "label", "name"]),
  project: z.string().min(1).max(200).optional(),
  service: z.string().min(1).max(200).optional(),
  containerName: z.string().min(1).max(128).optional(),
  labelValue: z.string().min(1).max(200).optional(),
});
export const resourceMethodSchemas = {
  "resources.list": z.object({
    nodeId: nodeId.optional(),
    type: z.string().optional(),
    identification: z
      .enum(["LOCATED", "MISSING", "CONFLICT", "STALE", "UNCONFIRMED"])
      .optional(),
    runtimeState: z.string().optional(),
    applicationId: applicationId.optional(),
  }),
  "resources.get": reference,
  "resources.discover": reference,
  "resources.resolve": reference.extend({
    expectedContainerId: containerId.optional(),
  }),
  "resources.logs": reference.extend({
    expectedContainerId: containerId,
    tail: z.number().int().min(1).max(2000).default(200),
  }),
  "resources.action": reference.extend({
    expectedContainerId: containerId,
    action: z.enum(["start", "stop", "restart", "remove"]),
    confirmed: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(200),
  }),
  "resources.preview": locator.extend({ resourceId: resourceId.optional() }),
  "resources.register": locator.extend({
    name,
    confirmed: z.literal(true),
    persistenceConfirmed: z.boolean().optional(),
  }),
  "resources.rebind": locator.extend({
    resourceId,
    name: name.optional(),
    confirmed: z.literal(true),
    persistenceConfirmed: z.boolean().optional(),
  }),
  "resources.update": reference.extend({ name }),
  "resources.associate": reference.extend({ applicationId }),
  "resources.unlink": reference.extend({
    applicationId,
    confirmed: z.literal(true),
  }),
};
export type ResourceMethod = keyof typeof resourceMethodSchemas;
export type ResourceStrategy = "compose" | "label" | "name" | "unconfirmed";
export type ResourceLocator = {
  strategy: ResourceStrategy;
  type: string;
  locatorKey: string | null;
  project: string | null;
  service: string | null;
  containerName: string | null;
  labelValue: string | null;
};
export const resourceSchema = z.object({
  id: resourceId,
  nodeId,
  name: z.string(),
  type: z.string(),
  strategy: z.string(),
  locatorKey: z.string().nullable(),
  project: z.string().nullable(),
  service: z.string().nullable(),
  containerName: z.string().nullable(),
  labelValue: z.string().nullable(),
  identification: z.string(),
  runtimeState: z.string(),
  instances: z.array(dockerContainerSchema),
  metadata: z.record(z.string(), z.unknown()),
  discoveryError: z.string().nullable(),
  lastDiscoveredAt: z.string().nullable(),
  lastAttemptedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  node: z.object({ id: z.string(), name: z.string() }),
  applications: z.array(
    z.object({
      applicationId,
      application: z.object({ id: z.string(), name: z.string() }),
    }),
  ),
});
export type ResourceData = z.infer<typeof resourceSchema>;
const previewSchema = z.object({
  locator: z.object({
    strategy: z.string(),
    type: z.string(),
    locatorKey: z.string().nullable(),
    project: z.string().nullable(),
    service: z.string().nullable(),
    containerName: z.string().nullable(),
    labelValue: z.string().nullable(),
  }),
  selected: dockerContainerSchema,
  instances: z.array(dockerContainerSchema),
  identification: z.string(),
  duplicates: z.array(z.object({ id: resourceId, name: z.string() })),
});
export const resourceOutputSchemas = {
  "resources.list": z.object({ data: z.array(resourceSchema) }),
  "resources.get": z.object({ data: resourceSchema }),
  "resources.discover": z.object({ data: resourceSchema }),
  "resources.resolve": z.object({
    data: resourceSchema.extend({ containerId: z.string() }),
  }),
  "resources.preview": z.object({ data: previewSchema }),
  "resources.logs": z.object({
    data: z.object({ output: z.string(), truncated: z.boolean() }),
  }),
  "resources.action": z.object({ data: z.record(z.string(), z.unknown()) }),
  "resources.register": z.object({ data: resourceSchema }),
  "resources.rebind": z.object({ data: resourceSchema }),
  "resources.update": z.object({ data: resourceSchema }),
  "resources.associate": z.object({ data: resourceSchema }),
  "resources.unlink": z.object({ data: resourceSchema }),
};
