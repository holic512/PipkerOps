/** Client-side exploration of bounded, already collected inventories. */
import type { Snapshot } from "./telemetry";
export function resourceWarning(
  metric: string,
  value: number | null | undefined,
  snapshot?: Snapshot,
) {
  if (metric === "load.1") {
    const load = snapshot?.series.find(
      (p) => p.metric === "load.normalized",
    )?.value;
    return typeof load === "number" && load >= 100
      ? "归一化负载偏高（≥100%）"
      : null;
  }
  return typeof value === "number" &&
    value >= 85 &&
    ["cpu.total", "memory.percent", "swap.percent", "disk.percent"].includes(
      metric,
    )
    ? "使用率偏高（≥85%）"
    : null;
}
export type MonitoringRow = Record<string, unknown>;
export type InventoryKind =
  "process" | "service" | "container" | "disk" | "network" | "io";
export function abnormalRow(row: MonitoringRow, kind: InventoryKind) {
  if (kind === "process")
    return Number(row.cpuPercent) >= 80 || Number(row.memoryPercent) >= 80;
  if (kind === "service")
    return row.active === "failed" || row.sub === "failed";
  if (kind === "container")
    return (
      row.health === "unhealthy" ||
      ["restarting", "dead"].includes(String(row.state)) ||
      Number(row.restartCount) >= 3 ||
      !!row.inspectError ||
      !!row.statsError
    );
  return (
    Number(row.usedPercent) >= 85 ||
    Number(row.inodesUsedPercent) >= 85 ||
    !!row.collectionError
  );
}
export function exploreRows(
  values: MonitoringRow[],
  kind: InventoryKind,
  query: string,
  abnormal: boolean,
  sort: string,
  device: string,
) {
  const [field, direction] = sort.split(":");
  const result = values.filter(
    (row) =>
      (!query ||
        JSON.stringify(row)
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())) &&
      (!abnormal || abnormalRow(row, kind)) &&
      (!device || String(row.mountpoint ?? row.name ?? row.device) === device),
  );
  if (field)
    result.sort((a, b) => {
      const x = a[field],
        y = b[field];
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      const comparison =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "zh-CN", { numeric: true });
      return direction === "desc" ? -comparison : comparison;
    });
  return result;
}
export type HistorySelection = {
  metric: string;
  device: string | undefined;
  hours: number;
};
export function changeHistoryMetric(
  current: HistorySelection,
  metric: string,
): HistorySelection {
  const family = (name: string) => name.split(".")[0];
  return {
    ...current,
    metric,
    device:
      family(metric) === family(current.metric)
        ? current.device
        : ["network", "io", "disk"].includes(family(metric))
          ? undefined
          : "",
  };
}
export function rowHistory(
  row: MonitoringRow,
  kind?: InventoryKind,
): Pick<HistorySelection, "metric" | "device"> | undefined {
  if (kind === "disk" && typeof row.mountpoint === "string" && row.mountpoint)
    return { metric: "disk.percent", device: String(row.mountpoint) };
  if (kind === "network" && typeof row.name === "string" && row.name)
    return { metric: "network.recv", device: String(row.name) };
  if (kind === "io" && typeof row.name === "string" && row.name)
    return { metric: "io.read", device: row.name };
  if (typeof row.rawMetric === "string")
    return { metric: row.rawMetric, device: "" };
}
