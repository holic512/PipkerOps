/** Versioned, bounded node telemetry shared by the gateway, API and history. */
import { z } from "zod";
export const categories = [
  "fast",
  "disks",
  "details",
  "static",
  "legacy",
] as const;
export type TelemetryCategory = (typeof categories)[number];
export const seriesPoint = z.object({
  metric: z.string().min(1).max(80),
  device: z.string().max(200).default(""),
  unit: z.string().max(20),
  value: z.number().finite().nullable(),
});
export const telemetryFrame = z.object({
  schemaVersion: z.literal(2),
  bootId: z.string().min(1).max(100),
  sequence: z.number().int().nonnegative(),
  category: z.enum(categories),
  sampledAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().finite().nonnegative(),
  data: z.record(z.string(), z.unknown()),
  series: z.array(seriesPoint).max(2048).default([]),
  errors: z.array(z.string().max(2000)).max(200).default([]),
  truncated: z.boolean().default(false),
});
export type TelemetryFrame = z.infer<typeof telemetryFrame>;
export type Snapshot = TelemetryFrame & { receivedAt: string };
export const telemetryChannel = "pko:telemetry:changed";
export const snapshotKey = (nodeId: string, category: string) =>
  `pko:telemetry:${nodeId}:${category}`;
export const categoryMaxAge = {
  fast: 20000,
  disks: 45000,
  details: 90000,
  static: 1200000,
  legacy: 45000,
};
export function snapshotFresh(snapshot: Snapshot, now = Date.now()) {
  return (
    now - Date.parse(snapshot.receivedAt) <= categoryMaxAge[snapshot.category]
  );
}
export function numericPercent(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}
/** Adapt legacy gauges without inventing rates from cumulative counters. */
export function legacySeries(data: Record<string, unknown>) {
  const points: TelemetryFrame["series"] = [];
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  function add(metric: string, value: unknown, unit: string, device = "") {
    points.push({
      metric,
      device,
      unit,
      value:
        unit === "%"
          ? numericPercent(value)
          : typeof value === "number" && Number.isFinite(value) && value >= 0
            ? value
            : null,
    });
  }
  const memory = object(data.memory);
  // These are part of every legacy sample; missing values are history gaps.
  add("cpu.total", data.cpuPercent, "%");
  add(
    "memory.percent",
    Object.hasOwn(data, "memoryPercent")
      ? data.memoryPercent
      : memory.usedPercent,
    "%",
  );
  for (const field of ["used", "available", "free", "cached", "buffers"])
    if (Object.hasOwn(memory, field))
      add(`memory.${field}`, memory[field], "B");
  const load = object(data.load);
  for (const period of [1, 5, 15])
    if (Object.hasOwn(load, `load${period}`))
      add(`load.${period}`, load[`load${period}`], "");
  const swap = object(data.swap);
  if (Object.hasOwn(swap, "used")) add("swap.used", swap.used, "B");
  if (Object.hasOwn(swap, "usedPercent"))
    add("swap.percent", swap.usedPercent, "%");
  const mounts = new Set<string>();
  for (const value of Array.isArray(data.disk) ? data.disk : []) {
    const disk = object(value),
      mount = disk.mountpoint;
    // A block device can back several mounts; use the v2 mount identity.
    if (
      typeof mount !== "string" ||
      !mount ||
      mount.length > 200 ||
      mounts.has(mount)
    )
      continue;
    mounts.add(mount);
    for (const [field, metric, unit] of [
      ["usedPercent", "disk.percent", "%"],
      ["used", "disk.used", "B"],
      ["inodesUsedPercent", "disk.inodePercent", "%"],
    ])
      if (Object.hasOwn(disk, field)) add(metric, disk[field], unit, mount);
    // v1 free and v2 available are both gopsutil's available capacity (bavail).
    // v2 data.free is filesystem free capacity (bfree), a different gauge.
    if (Object.hasOwn(disk, "available") || Object.hasOwn(disk, "free"))
      add(
        "disk.free",
        Object.hasOwn(disk, "available") ? disk.available : disk.free,
        "B",
        mount,
      );
  }
  return points;
}

/** Also covers legacy snapshots persisted before gauge series were populated. */
export function withLegacySeries<T extends TelemetryFrame>(frame: T): T {
  if (frame.category !== "legacy") return frame;
  const present = new Set(
    frame.series.map((point) => JSON.stringify([point.metric, point.device])),
  );
  return {
    ...frame,
    series: [
      ...frame.series,
      ...legacySeries(frame.data).filter(
        (point) => !present.has(JSON.stringify([point.metric, point.device])),
      ),
    ],
  };
}
/** History excludes volatile high-cardinality inventory. */
export function historyPayload(snapshots: Snapshot[]) {
  const data: Record<string, unknown> = {};
  for (const snapshot of snapshots)
    if (["fast", "disks", "legacy"].includes(snapshot.category))
      Object.assign(data, snapshot.data);
  for (const name of [
    "processes",
    "ports",
    "containers",
    "services",
    "cpuCores",
    "interfaces",
  ])
    delete data[name];
  return data;
}
export function acceptSequence(
  previous: Snapshot | undefined,
  next: TelemetryFrame,
) {
  return (
    !previous ||
    previous.bootId !== next.bootId ||
    next.sequence > previous.sequence
  );
}

/** Prefer the currently reporting protocol/boot over snapshots left by an upgrade. */
export function preferredSnapshots<T extends Snapshot>(values: T[]): T[] {
  const fast = values.find((s) => s.category === "fast"),
    legacy = values.find((s) => s.category === "legacy");
  if (legacy && (!fast || legacy.receivedAt > fast.receivedAt)) return [legacy];
  return values.filter(
    (s) => s.category !== "legacy" && (!fast || s.bootId === fast.bootId),
  );
}
