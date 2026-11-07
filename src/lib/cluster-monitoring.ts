import { numericPercent, type Snapshot } from "./telemetry";
import {
  currentSnapshot,
  monitoringAlertMetrics,
  monitoringObservation,
} from "./monitoring-alerts";
type SummaryNode = {
  id: string;
  name: string;
  labels: string[];
  connected: boolean;
  metrics: {
    recordedAt: string | Date;
    cpuPercent: number | null;
    memoryPercent: number | null;
  }[];
};
/** Fresh static inventory must never hide missing resource samples. */
export function clusterProjection(
  node: SummaryNode,
  snapshots: Snapshot[],
  now = Date.now(),
) {
  const resource =
    snapshots.find((s) => s.category === "fast") ??
    snapshots.find((s) => s.category === "legacy");
  const last = node.metrics[0];
  const stamp =
    resource?.sampledAt ??
    (last ? new Date(last.recordedAt).toISOString() : null);
  const age = stamp ? now - Date.parse(stamp) : Infinity;
  const longMissing = !Number.isFinite(age) || age > 300000;
  const fresh =
    node.connected &&
    (resource ? currentSnapshot(resource, now) : age >= -30000 && age <= 45000);
  const gauge = (field: "cpuPercent" | "memoryPercent", metric: string) =>
    !fresh
      ? null
      : resource
        ? numericPercent(
            resource.data[field] ??
              resource.series.find((p) => p.metric === metric)?.value,
          )
        : numericPercent(last?.[field]);
  const cpuPercent = gauge("cpuPercent", "cpu.total"),
    memoryPercent = gauge("memoryPercent", "memory.percent");
  const observations = Object.fromEntries(
    monitoringAlertMetrics.map((metric) => [
      metric,
      monitoringObservation(metric, snapshots, now),
    ]),
  );
  const reasons = [
    ...(!node.connected ? ["节点离线"] : []),
    ...(longMissing ? ["实时资源超过 5 分钟无采样或从未采样"] : []),
    ...(cpuPercent !== null && cpuPercent >= 85 ? ["CPU 使用率偏高"] : []),
    ...(memoryPercent !== null && memoryPercent >= 85
      ? ["内存使用率偏高"]
      : []),
    ...(Object.values(observations).some((v) => !v.complete)
      ? ["部分指标无法确认，请检查采集诊断"]
      : []),
    ...Object.entries(observations)
      .filter(
        ([m, v]) =>
          v.value !== null &&
          (["diskPercent", "inodePercent"].includes(m)
            ? v.value >= 85
            : v.value > 0),
      )
      .map(([, v]) => v.context),
  ];
  return {
    id: node.id,
    name: node.name,
    labels: node.labels,
    connected: node.connected,
    lastSampleAt: stamp,
    longMissing,
    cpuPercent,
    memoryPercent,
    observations,
    reasons,
  };
}
export function clusterTarget(
  node: {
    longMissing: boolean;
    observations: Record<string, { value: number | null }>;
  },
  ranking: string,
) {
  if (node.longMissing) return "details";
  if (
    (node.observations.serviceFailure?.value ?? 0) > 0 ||
    (node.observations.containerFailure?.value ?? 0) > 0
  )
    return "services";
  return ["cpuPercent", "memoryPercent"].includes(ranking)
    ? "live"
    : "resources";
}
