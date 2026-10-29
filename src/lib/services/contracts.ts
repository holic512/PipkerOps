/**
 * @file contracts.ts
 * @project PipkerOps
 * @module business-contracts
 * @description Web/MCP 共享业务方法和输入校验，以及核心方法的JSON输出契约。
 * @logic 方法参数只维护一份；Key限定已知scope，任务公开对应payload，实际执行仍重查权限与持久资源。
 * @dependencies Zod, task specifications
 * @index_tags api, mcp, validation, contracts
 * @author holic512
 */
import { z } from "zod";
import { taskInput, taskSpecs } from "./tasks";
const label = z.string().trim().min(1).max(120);
const id = z.string().min(1).max(100);
const object = z.record(z.string(), z.unknown());
const confirmation = z
  .boolean()
  .optional()
  .describe("危险操作须操作者明确确认后传true；许可仍由服务端验证");
export const httpProbeConfig = z.object({
  method: z
    .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    .default("GET"),
  headers: z.record(z.string(), z.string().max(8192)).default({}),
  body: z.string().max(131072).optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
});
export const METHODS = [
  "overview",
  "nodes.list",
  "nodes.token",
  "nodes.approve",
  "nodes.reject",
  "nodes.revoke",
  "nodes.metrics",
  "nodes.history",
  "nodes.update",
  "applications.list",
  "applications.save",
  "applications.delete",
  "deployments.save",
  "deployments.delete",
  "dependencies.save",
  "dependencies.delete",
  "probes.list",
  "probes.save",
  "probes.run",
  "probes.history",
  "probes.delete",
  "topology",
  "tasks.list",
  "tasks.get",
  "tasks.create",
  "tasks.cancel",
  "sites.list",
  "sites.save",
  "sites.apply",
  "sites.certificate",
  "sites.acme",
  "sites.https",
  "sites.renew",
  "sites.delete",
  "actions.list",
  "actions.save",
  "actions.run",
  "actions.delete",
  "schedules.list",
  "schedules.save",
  "schedules.delete",
  "alerts.list",
  "alerts.save",
  "alerts.delete",
  "notifications.list",
  "notifications.read",
  "keys.list",
  "keys.create",
  "keys.revoke",
  "audit.list",
  "terminal.ticket",
  "users.me",
] as const;
export type Method = (typeof METHODS)[number];
export const mutation = (method: string) =>
  !["overview", "topology"].includes(method) &&
  !method.endsWith(".list") &&
  !method.endsWith(".get") &&
  !method.endsWith(".history") &&
  !method.endsWith(".metrics") &&
  method !== "users.me";
export const methodSchemas = {
  overview: z.object({}),
  "nodes.list": z.object({}),
  "nodes.token": z.object({
    name: label,
    maxUses: z.number().int().min(1).max(50).default(1),
    hours: z.number().min(1).max(168).default(24),
  }),
  "nodes.approve": z.object({ id, confirmed: confirmation }),
  "nodes.reject": z.object({ id, confirmed: confirmation }),
  "nodes.revoke": z.object({ id, confirmed: confirmation }),
  "nodes.metrics": z.object({
    nodeId: id,
    hours: z.number().min(1).max(8760).default(24),
  }),
  "nodes.history": z.object({
    nodeId: id,
    kind: z.enum(["disk", "network", "io"]),
    hours: z.number().min(1).max(8760).default(1),
    device: z.string().min(1).max(200).optional(),
  }),
  "nodes.update": z.object({
    id,
    name: label,
    labels: z.array(label).max(50).default([]),
  }),
  "applications.list": z.object({}),
  "applications.save": z.object({
    id: id.optional(),
    name: label,
    description: z.string().max(2000).optional(),
    labels: z.array(label).max(20).default([]),
    businessData: object.default({}),
  }),
  "applications.delete": z.object({ id, confirmed: confirmation }),
  "deployments.save": z.object({
    id: id.optional(),
    applicationId: id,
    nodeId: id,
    name: label,
    type: z.enum([
      "docker",
      "compose",
      "systemd",
      "process",
      "database",
      "nginx",
    ]),
    target: z.string().min(1).max(500),
    healthUrl: z.url().nullable().optional(),
    metadata: object.default({}),
  }),
  "deployments.delete": z.object({ id, confirmed: confirmation }),
  "dependencies.save": z.object({
    fromApplicationId: id,
    toApplicationId: id,
    type: label.default("depends_on"),
    description: z.string().max(500).optional(),
  }),
  "dependencies.delete": z.object({ id, confirmed: confirmation }),
  "probes.list": z.object({}),
  "probes.save": z
    .object({
      id: id.optional(),
      name: label,
      type: z.enum(["HTTP", "TCP"]),
      target: z.string().min(1).max(2048),
      sourceNodeId: id.nullable().optional(),
      applicationId: id.nullable().optional(),
      intervalSeconds: z.number().int().min(10).max(86400).default(60),
      timeoutMs: z.number().int().min(100).max(30000).default(5000),
      failureThreshold: z.number().int().min(1).max(100).default(3),
      enabled: z.boolean().default(true),
      config: httpProbeConfig.default({ method: "GET", headers: {} }),
      mapping: z.record(z.string(), z.string()).default({}),
    })
    .extend({ confirmed: confirmation }),
  "probes.run": z.object({ id, confirmed: confirmation }),
  "probes.history": z.object({ id }),
  "probes.delete": z.object({ id, confirmed: confirmation }),
  topology: z.object({}),
  "tasks.list": z.object({}),
  "tasks.get": z.object({ id }),
  "tasks.create": taskInput,
  "tasks.cancel": z.object({ id, confirmed: confirmation }),
  "sites.list": z.object({}),
  "sites.save": z.object({
    id: id.optional(),
    name: label,
    nodeId: id,
    domain: z
      .string()
      .regex(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
    upstream: z.url(),
    config: z.string().max(131072).default(""),
  }),
  "sites.apply": z.object({ id, confirmed: confirmation }),
  "sites.certificate": z.object({ id, staging: z.boolean().default(false) }),
  "sites.acme": z.object({
    id,
    email: z.email().max(200),
    staging: z.boolean().default(false),
    confirmed: confirmation,
  }),
  "sites.https": z.object({
    id,
    autoRenew: z.boolean().default(true),
    confirmed: confirmation,
  }),
  "sites.renew": z.object({
    id,
    staging: z.boolean().default(false),
    confirmed: confirmation,
  }),
  "sites.delete": z.object({ id, confirmed: confirmation }),
  "actions.list": z.object({}),
  "actions.save": z
    .object({
      id: id.optional(),
      name: label,
      type: z.enum(["shell.exec", "docker.action", "HTTP", "URL"]),
      description: z.string().max(1000).optional(),
      config: object,
      parameters: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            label: label,
            required: z.boolean().default(true),
          }),
        )
        .max(20)
        .default([]),
      nodeIds: z.array(id).max(100).default([]),
    })
    .extend({ confirmed: confirmation }),
  "actions.run": z.object({
    id,
    idempotencyKey: taskInput.shape.idempotencyKey,
    nodeId: id.optional(),
    values: z.record(z.string(), z.string().max(4000)).default({}),
    confirmed: confirmation,
  }),
  "actions.delete": z.object({ id, confirmed: confirmation }),
  "schedules.list": z.object({}),
  "schedules.save": z.object({
    id: id.optional(),
    enabled: z.boolean().default(true),
    name: label,
    cron: z.string().max(100),
    timezone: z.string().max(80).default("Asia/Shanghai"),
    taskType: z.string(),
    nodeId: id.optional(),
    payload: object.default({}),
    confirmed: z.boolean().optional(),
  }),
  "schedules.delete": z.object({ id, confirmed: confirmation }),
  "alerts.list": z.object({}),
  "alerts.save": z.object({
    id: id.optional(),
    enabled: z.boolean().default(true),
    name: label,
    nodeId: id.optional(),
    probeId: id.optional(),
    metric: z.enum(["cpuPercent", "memoryPercent", "offline", "probeFailure"]),
    operator: z.enum(["gt", "lt"]).default("gt"),
    threshold: z.number().finite(),
    durationSeconds: z.number().int().min(0).max(86400).default(60),
    webhookUrl: z
      .url()
      .refine((v) => v.startsWith("https://"))
      .optional(),
  }),
  "alerts.delete": z.object({ id, confirmed: confirmation }),
  "notifications.list": z.object({}),
  "notifications.read": z.object({ id }),
  "keys.list": z.object({}),
  "keys.create": z
    .object({
      name: label,
      scopes: z
        .array(
          z.enum(
            [
              "*",
              "nodes:read",
              "nodes:write",
              "nodes:approve",
              "apps:read",
              "apps:write",
              "probes:read",
              "probes:write",
              "docker:read",
              "docker:write",
              "files:read",
              "files:write",
              "system:read",
              "system:write",
              "sites:read",
              "sites:write",
              "actions:read",
              "actions:write",
              "schedules:read",
              "schedules:write",
              "alerts:read",
              "alerts:write",
              "tasks:read",
              "tasks:write",
              "terminal:write",
              "keys:write",
              "admin:write",
            ],
            { error: "工具权限不受支持，请检查 scope 名称" },
          ),
        )
        .min(1)
        .max(50)
        .describe("工具scope列表；*表示全部工具，仍受节点范围与高危许可限制"),
      nodeIds: z.array(id).max(100).default([]),
      allowDangerous: z.boolean().default(false),
      days: z.number().int().min(1).max(365).default(30),
    })
    .extend({ confirmed: confirmation }),
  "keys.revoke": z.object({ id, confirmed: confirmation }),
  "audit.list": z.object({}),
  "terminal.ticket": z.object({
    nodeId: id,
    containerId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
      .optional(),
    confirmed: confirmation,
  }),
  "users.me": z.object({}),
} satisfies Record<Method, z.ZodObject>;

const taskVariants = Object.entries(taskSpecs).map(([type, spec]) =>
  taskInput.extend({ type: z.literal(type), payload: spec.schema }),
);
export const mcpTaskInput = z.discriminatedUnion(
  "type",
  taskVariants as [
    (typeof taskVariants)[number],
    ...(typeof taskVariants)[number][],
  ],
);

const wireDate = z.iso.datetime();
const wireTask = z
  .object({
    id,
    type: z.string(),
    nodeId: z.string().nullable(),
    status: z.enum([
      "QUEUED",
      "DISPATCHED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "UNKNOWN",
    ]),
    source: z.enum(["WEB", "MCP", "CRON", "SYSTEM"]),
    payload: object,
    result: object,
    output: z.string().nullable(),
    error: z.string().nullable(),
    idempotent: z.boolean(),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    createdAt: wireDate,
    startedAt: wireDate.nullable(),
    finishedAt: wireDate.nullable(),
    logs: z
      .array(
        z
          .object({
            sequence: z.number().int().nonnegative(),
            stream: z.string(),
            message: z.string(),
            createdAt: wireDate,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const wireNode = z
  .object({
    id,
    name: z.string(),
    hostname: z.string().nullable(),
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "REVOKED"]),
    connected: z.boolean(),
    lastSeenAt: wireDate.nullable(),
    metrics: z.array(
      z
        .object({
          recordedAt: wireDate,
          cpuPercent: z.number(),
          memoryPercent: z.number(),
          payload: object,
        })
        .passthrough(),
    ),
  })
  .passthrough();
const wireApplication = z
  .object({
    id,
    name: z.string(),
    description: z.string().nullable(),
    labels: z.array(z.string()),
    businessData: object,
    deployments: z.array(
      z
        .object({
          id,
          applicationId: id,
          nodeId: id,
          name: z.string(),
          type: z.string(),
          target: z.string(),
          status: z.string(),
        })
        .passthrough(),
    ),
    probes: z.array(
      z
        .object({
          id,
          name: z.string(),
          status: z.string(),
          enabled: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const wireMetricValues = z.object({
  sampleCount: z.number().int().positive(),
  cpuMax: z.number(),
  memoryMax: z.number(),
});
const wireMetricHistory = z.discriminatedUnion("resolution", [
  z.object({
    resolution: z.literal("raw"),
    bucketSeconds: z.number().int().positive(),
    samples: z
      .array(
        wireMetricValues.extend({
          recordedAt: wireDate,
          cpuPercent: z.number(),
          memoryPercent: z.number(),
        }),
      )
      .max(1440),
  }),
  z.object({
    resolution: z.literal("hour"),
    bucketSeconds: z.literal(3600),
    samples: z
      .array(
        wireMetricValues.extend({
          bucketAt: wireDate,
          cpuAvg: z.number(),
          memoryAvg: z.number(),
        }),
      )
      .max(8761),
  }),
]);
const wireDeviceHistory = z.object({
  unit: z.enum(["%", "B/s"]),
  bucketSeconds: z.number().int().positive(),
  devices: z.array(z.string()),
  device: z.string().nullable(),
  series: z.array(
    z.object({
      name: z.string(),
      points: z.array(
        z.object({
          recordedAt: z.iso.datetime({ offset: true }),
          value: z.number().nullable(),
        }),
      ),
    }),
  ),
});

/** Wire contracts after the shared business result's normal JSON serialization. */
export const methodOutputSchemas: Partial<Record<Method, z.ZodObject>> = {
  "nodes.list": z.object({ data: z.array(wireNode) }),
  "nodes.metrics": z.object({ data: wireMetricHistory }),
  "nodes.history": z.object({ data: wireDeviceHistory }),
  "applications.list": z.object({ data: z.array(wireApplication) }),
  "tasks.create": z.object({ data: wireTask }),
  "tasks.get": z.object({
    data: wireTask.extend({ logs: wireTask.shape.logs.unwrap() }),
  }),
  "tasks.list": z.object({ data: z.array(wireTask) }),
};
