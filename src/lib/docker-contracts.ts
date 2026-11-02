/**
 * @file docker-contracts.ts
 * @project PipkerOps
 * @module docker-contracts
 * @description Docker 直连输入、Agent 快照与 Web/MCP 结构化输出。
 * @logic 入口统一校验节点、资源身份和确认参数；读取与写入共享明确的方法集合。
 * @dependencies Zod
 * @index_tags docker, compose, contracts, operation-log
 * @author holic512
 */
import { z } from "zod";

const nodeId = z.string().min(1).max(100);
const containerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const project = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const node = z.object({ nodeId });
const write = node.extend({ idempotencyKey: z.string().min(8).max(200) });
const confirmed = z.boolean().optional();
export const dockerMethodSchemas = {
  "docker.list": node,
  "docker.inspect": node.extend({ id: containerId }),
  "docker.stats": node.extend({ id: containerId.optional() }),
  "docker.logs": node.extend({
    id: containerId,
    tail: z.number().int().min(1).max(2000).default(200),
  }),
  "compose.list": node,
  "compose.status": node.extend({ project }),
  "compose.read": node.extend({ project }),
  "docker.action": write.extend({
    id: containerId,
    action: z.enum(["start", "stop", "restart", "remove"]),
    confirmed,
  }),
  "docker.pull": write.extend({
    image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,254}$/),
  }),
  "compose.deploy": write.extend({
    project,
    yaml: z.string().min(1).max(131072),
    confirmed,
  }),
  "docker.operations.list": node,
  "docker.operations.get": z.object({ id: z.uuid() }),
};
export type DockerMethod = keyof typeof dockerMethodSchemas;
export const dockerReadMethods = [
  "docker.list",
  "docker.inspect",
  "docker.stats",
  "docker.logs",
  "compose.list",
  "compose.status",
  "compose.read",
  "docker.operations.list",
  "docker.operations.get",
];
export const dockerWriteMethods = [
  "docker.action",
  "docker.pull",
  "compose.deploy",
];
export const dockerLogSchema = z.object({
  sequence: z.number().int().positive(),
  stream: z.string().max(20),
  message: z.string().max(32768),
});
const result = z.record(z.string(), z.unknown());
export const dockerSnapshotSchema = z.object({
  id: z.uuid(),
  method: z.enum(["docker.action", "docker.pull", "compose.deploy"]),
  status: z.enum(["REQUESTED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"]),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  output: z.string().max(262144),
  error: z.string().nullable(),
  result,
  logs: z.array(dockerLogSchema).max(1024),
  truncated: z.boolean(),
});
export const dockerOperationSchema = dockerSnapshotSchema.extend({
  nodeId,
  target: z.string(),
  action: z.string().nullable(),
  source: z.string(),
  createdAt: z.iso.datetime(),
});
export type DockerOperation = z.infer<typeof dockerOperationSchema>;
export type DockerOperationSummary = Omit<
  DockerOperation,
  "output" | "error" | "result" | "logs"
>;
export const dockerContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  ports: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type DockerContainer = z.infer<typeof dockerContainerSchema>;
export const composeProjectSchema = z.object({
  name: z.string(),
  status: z.string(),
  managed: z.boolean(),
});
export type ComposeProject = z.infer<typeof composeProjectSchema>;
export const dockerResultSchemas = {
  "docker.list": z.object({ containers: z.array(dockerContainerSchema) }),
  "docker.inspect": z.object({ containers: z.array(result) }),
  "docker.stats": z.object({
    containers: z.array(
      z.record(z.string(), z.union([z.string(), z.number()])),
    ),
  }),
  "docker.logs": z.object({ output: z.string(), truncated: z.boolean() }),
  "compose.list": z.object({ projects: z.array(composeProjectSchema) }),
  "compose.status": z.object({ services: z.array(result) }),
  "compose.read": z.object({ project: z.string(), yaml: z.string() }),
};
