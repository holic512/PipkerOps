import { snapshotFresh, type Snapshot } from "./telemetry";
import { activeContainerMetric, assessContainer } from "./container-monitoring";
export const monitoringAlertMetrics = [
  "diskPercent",
  "inodePercent",
  "collectionFailure",
  "serviceFailure",
  "containerFailure",
  activeContainerMetric,
] as const;
export function currentSnapshot(s: Snapshot, now: number) {
  return snapshotFresh(s, now);
}
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];
export type MonitoringObservation = {
  value: number | null;
  complete: boolean;
  context: string;
  observedAt?: number;
};
export function monitoringObservation(
  metric: string,
  snapshots: Snapshot[],
  now = Date.now(),
): MonitoringObservation {
  const missing = { value: null, complete: false, context: "等待有效采样" };
  if (metric === "collectionFailure") {
    if (!snapshots.some((s) => s.category !== "legacy")) {
      const legacy = snapshots.find((s) => s.category === "legacy");
      return {
        value:
          !legacy || !currentSnapshot(legacy, now) || legacy.errors.length
            ? 1
            : 0,
        complete: true,
        context: "旧 Agent 按实际 legacy 采集检查存活；详细采集类别需升级",
      };
    }
    const required = ["fast", "disks", "details", "static"];
    const failed = required.filter((c) => {
      const s = snapshots.find((v) => v.category === c);
      return !s || !currentSnapshot(s, now) || s.errors.length > 0;
    });
    return {
      value: failed.length,
      complete: true,
      context: failed.length
        ? `采集失效类别：${failed.join("、")}`
        : "所有采集类别已恢复",
    };
  }
  const disk = metric === "diskPercent" || metric === "inodePercent";
  const s =
    snapshots.find((v) => v.category === (disk ? "disks" : "details")) ??
    (metric === "diskPercent"
      ? snapshots.find((v) => v.category === "legacy")
      : undefined);
  if (!s || !currentSnapshot(s, now)) return missing;
  let complete = !s.truncated;
  if (disk) {
    complete &&= s.errors.length === 0;
    const points = s.series.filter(
      (p) =>
        p.metric ===
        (metric === "diskPercent" ? "disk.percent" : "disk.inodePercent"),
    );
    const values = points.filter(
      (p) => typeof p.value === "number" && p.value >= 0 && p.value <= 100,
    );
    complete &&= points.length === values.length;
    // Empty/unsupported filesystems are not a healthy zero-percent observation.
    if (!values.length) return missing;
    const highest = values.reduce((a, b) => (a.value! >= b.value! ? a : b));
    return {
      value: highest.value,
      complete,
      context: `挂载点 ${highest.device}：${highest.value}%`,
      observedAt: Date.parse(s.sampledAt),
    };
  }
  const services = metric === "serviceFailure",
    field = services ? "services" : "containers";
  if (!Object.hasOwn(s.data, field)) return missing;
  if (metric === activeContainerMetric) {
    if (!Array.isArray(s.data.containers)) return missing;
    const assessments = rows(s.data.containers).map((row) => ({
      name: String(row.name ?? row.id ?? "未知容器"),
      ...assessContainer(row),
    }));
    const bad = assessments.filter((result) => result.status === "failure");
    complete =
      (s.data.containerInventoryTruncated === false ||
        (s.data.containerInventoryTruncated === undefined && !s.truncated)) &&
      !s.errors.some((error) => /^(docker(?!Stats)|containers)/.test(error)) &&
      assessments.length === s.data.containers.length &&
      !assessments.some((result) => result.status === "unknown");
    return {
      value: bad.length || (complete ? 0 : null),
      complete,
      observedAt: Date.parse(s.sampledAt),
      context: bad.length
        ? `容器异常：${bad
            .slice(0, 10)
            .map(({ name, reason }) => `${name}（${reason}）`)
            .join("、")}${bad.length > 10 ? "等" : ""}`
        : complete
          ? "未观察到容器异常"
          : "等待完整容器状态与近期重启采样",
    };
  }
  complete &&= !s.errors.some((e) =>
    services ? /^(systemd|services)/.test(e) : /^(docker|containers)/.test(e),
  );
  const observed = rows(s.data[field]);
  const bad = observed.filter((r) =>
    services
      ? r.active === "failed" || r.sub === "failed"
      : r.health === "unhealthy" ||
        ["dead", "restarting"].includes(String(r.state)) ||
        Number(r.restartCount) >= 3,
  );
  complete &&= !observed.some(
    (r) => r.inspectError || (services ? !r.active : !r.state),
  );
  return {
    value: bad.length,
    complete,
    observedAt: Date.parse(s.sampledAt),
    context: bad.length
      ? `${services ? "服务" : "容器"}异常：${bad
          .slice(0, 10)
          .map((r) => String(r.name ?? r.id))
          .join("、")}${bad.length > 10 ? "等" : ""}`
      : `未观察到${services ? "服务" : "容器"}异常`,
  };
}
export function observationValue(
  observation: MonitoringObservation,
  operator: string,
  threshold: number,
) {
  if (observation.complete) return observation.value;
  // Partial inventory proves a lower bound only, so it may prove a > breach.
  return operator === "gt" &&
    observation.value !== null &&
    observation.value > threshold
    ? observation.value
    : null;
}
