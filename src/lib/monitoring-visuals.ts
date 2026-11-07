import type { StateSlice } from "@/components/ui/chart";

export type MonitoringRow = Record<string, unknown>;
export const monitoringRows = (value: unknown): MonitoringRow[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is MonitoringRow =>
          !!v && typeof v === "object" && !Array.isArray(v),
      )
    : [];
export function stateSlices(
  rows: MonitoringRow[],
  kind: "service" | "container",
): StateSlice[] {
  const counts = new Map<string, StateSlice>();
  for (const row of rows) {
    const state = String(row.active ?? row.state ?? "unknown").toLowerCase();
    const health = String(row.health ?? "unknown").toLowerCase();
    const [name, tone]: [string, StateSlice["tone"]] = row.inspectError
      ? ["详情采集失败", "unknown"]
      : ["failed", "dead"].includes(state)
        ? ["失败", "danger"]
        : kind === "container" && health === "unhealthy"
          ? ["不健康", "danger"]
          : state === "restarting"
            ? ["重启中", "warning"]
            : ["inactive", "exited", "created", "paused"].includes(state)
              ? ["停止 / 暂停", "muted"]
              : kind === "container" && health === "none"
                ? ["未配置健康检查", "muted"]
                : kind === "container" && health === "starting"
                  ? ["健康检查启动中", "warning"]
                  : ["active", "running"].includes(state)
                    ? ["运行", "normal"]
                    : ["其他 / 未知", "unknown"];
    const item = counts.get(name) ?? { name, tone, value: 0 };
    item.value++;
    counts.set(name, item);
  }
  return [...counts.values()];
}

/** Keep a missing interval visible even if the source has no explicit null frame. */
export function insertSamplingGaps(
  points: { recordedAt: string; value: number | null }[],
  maxIntervalMs: number,
) {
  const result: typeof points = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (
      previous &&
      Date.parse(point.recordedAt) - Date.parse(previous.recordedAt) >
        maxIntervalMs
    )
      result.push({
        recordedAt: new Date(
          Date.parse(previous.recordedAt) + maxIntervalMs,
        ).toISOString(),
        value: null,
      });
    result.push(point);
  }
  return result;
}
