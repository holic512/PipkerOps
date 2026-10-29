/**
 * @file client.ts
 * @project PipkerOps
 * @module client-api
 * @description 浏览器API边界与业务数据契约。
 * @logic RPC错误统一封装，数值空态保留未知语义。
 * @dependencies fetch, Intl
 * @index_tags api, identity, entry
 * @author holic512
 */
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function rpc<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new RequestError(result.error ?? "请求失败", response.status);
  return result.data;
}
export const date = (v?: string | null) =>
  v
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "medium",
      }).format(new Date(v))
    : "—";
export const percent = (v?: number | null) =>
  v === null || v === undefined ? "暂无采样" : `${v.toFixed(1)}%`;
export type Metric = {
  id: string;
  recordedAt: string;
  cpuPercent: number;
  memoryPercent: number;
  payload: Record<string, unknown>;
};
export type NodeData = {
  id: string;
  name: string;
  hostname: string | null;
  status: string;
  connected: boolean;
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  labels: string[];
  metrics: Metric[];
};
export type AppData = {
  id: string;
  name: string;
  description: string | null;
  labels: string[];
  businessData: Record<string, unknown>;
  deployments: DeploymentData[];
  probes: { id: string; name: string; status: string }[];
};
export type DeploymentData = {
  id: string;
  name: string;
  type: string;
  target: string;
  nodeId: string;
  status: string;
  applicationId: string;
  node?: { id: string; name: string; lastSeenAt: string | null };
};
export type ProbeData = {
  id: string;
  name: string;
  type: string;
  target: string;
  status: string;
  sourceNodeId: string | null;
  sourceNode?: { name: string };
  intervalSeconds: number;
  failureCount: number;
  failureThreshold: number;
  enabled: boolean;
  lastCheckedAt: string | null;
  results: {
    latencyMs: number;
    success: boolean;
    recordedAt: string;
    data: Record<string, unknown>;
  }[];
};
export type TaskData = {
  idempotent: boolean;
  attempts: number;
  id: string;
  type: string;
  nodeId: string | null;
  status: string;
  source: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  output: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  node?: { name: string };
  logs?: { sequence: number; stream: string; message: string }[];
};
