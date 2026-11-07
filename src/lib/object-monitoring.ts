import { z } from "zod";
import type { TelemetryFrame } from "./telemetry";

export const objectKinds = [
  "process",
  "container",
  "service",
  "diagnostics",
] as const;
export type ObjectKind = (typeof objectKinds)[number];
export const processIdentity = z.object({
  bootId: z.string().min(1).max(100),
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^[0-9]{1,30}$/),
});
export const processObjectId = (p: z.infer<typeof processIdentity>) =>
  `${p.bootId}:${p.pid}:${p.startTicks}`;
export type ObjectMetric = {
  value: number | null;
  unit: string;
  weightMs: number;
  status?: string;
};
export type Observation = {
  kind: ObjectKind;
  objectId: string;
  identity: Record<string, unknown>;
  state: string;
  coverage: string;
  reason: string;
  metrics: Record<string, ObjectMetric>;
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const rows = (v: unknown, max: number) =>
  Array.isArray(v) ? v.slice(0, max).map(record) : [];
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export const objectMetricUnits: Record<ObjectKind, Record<string, string>> = {
  process: {
    cpuPercent: "%",
    memoryPercent: "%",
    rss: "B",
    vms: "B",
    readRate: "B/s",
    writeRate: "B/s",
    threads: "",
  },
  container: {
    cpuPercent: "%",
    memoryPercent: "%",
    memoryUsed: "B",
    memoryLimit: "B",
    networkRecv: "B/s",
    networkSent: "B/s",
    ioRead: "B/s",
    ioWrite: "B/s",
    restartCount: "",
  },
  service: { observations: "samples" },
  diagnostics: { durationMs: "ms", intervalMs: "ms", freshnessMs: "ms" },
};
export function observationMetrics(
  kind: ObjectKind,
  row: Record<string, unknown>,
  weightMs = 30000,
) {
  const errors = record(row.fieldErrors);
  return Object.fromEntries(
    Object.entries(objectMetricUnits[kind]).map(([key, unit]) => [
      key,
      {
        unit,
        value: errors[key] ? null : finite(row[key]),
        weightMs: unit.endsWith("/s")
          ? (finite(row.intervalMs) ?? weightMs)
          : 1,
        status: errors[key] ? "failed" : undefined,
      },
    ]),
  );
}
export function frameObservations(
  frame: TelemetryFrame,
  elapsedMs: number,
  now = Date.now(),
): Observation[] {
  const diagnostic: Observation = {
    kind: "diagnostics",
    objectId: frame.category,
    identity: { name: frame.category },
    state: frame.errors.some((e) => /permission|denied|not permitted/i.test(e))
      ? "permission_denied"
      : frame.errors.length
        ? "failed"
        : frame.truncated
          ? "truncated"
          : "ok",
    coverage: frame.truncated
      ? "truncated"
      : frame.errors.length
        ? "partial"
        : "covered",
    reason: frame.errors.join("；"),
    metrics: observationMetrics("diagnostics", {
      durationMs: frame.durationMs,
      intervalMs: elapsedMs || null,
      freshnessMs: Math.max(0, now - Date.parse(frame.sampledAt)),
    }),
  };
  if (frame.category !== "details" || frame.data.historyVersion !== 1)
    return [diagnostic];
  const result: Observation[] = [diagnostic];
  for (const row of rows(frame.data.processHistory, 60)) {
    const identity = processIdentity.safeParse(row);
    if (!identity.success || identity.data.bootId !== frame.bootId) continue;
    result.push({
      kind: "process",
      objectId: processObjectId(identity.data),
      identity: {
        ...identity.data,
        name: String(row.name ?? "").slice(0, 200),
      },
      state: Array.isArray(row.status)
        ? row.status.join(",")
        : String(row.status ?? "unknown"),
      coverage: row.collectionError ? "failed" : "covered",
      reason: String(row.collectionError ?? ""),
      metrics: observationMetrics("process", row),
    });
  }
  for (const row of rows(frame.data.containers, 200)) {
    if (typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id)) continue;
    result.push({
      kind: "container",
      objectId: row.id,
      identity: {
        id: row.id,
        name: String(row.name ?? "").slice(0, 200),
        startedAt: row.startedAt ?? null,
      },
      state: `${row.state ?? "unknown"}/${row.health ?? "unknown"}/restarts:${row.restartCount ?? "unknown"}`,
      coverage: row.inspectError
        ? "failed"
        : row.statsError
          ? "partial"
          : "covered",
      reason: String(row.inspectError ?? row.statsError ?? ""),
      metrics: observationMetrics("container", {
        ...record(row.metrics),
        restartCount: row.restartCount,
      }),
    });
  }
  for (const row of rows(frame.data.services, 200)) {
    if (
      typeof row.name !== "string" ||
      !row.name.endsWith(".service") ||
      row.name.length > 256
    )
      continue;
    result.push({
      kind: "service",
      objectId: row.name,
      identity: { name: row.name },
      state: `${row.active ?? "unknown"}/${row.sub ?? "unknown"}`,
      coverage: "covered",
      reason: "",
      metrics: observationMetrics("service", { observations: 1 }),
    });
  }
  return [
    ...new Map(result.map((r) => [`${r.kind}:${r.objectId}`, r])).values(),
  ];
}

export function objectHistoryResolution(
  hours: number,
  from?: string,
  to?: string,
  now = Date.now(),
) {
  const end = to ? Date.parse(to) : now;
  const start = from ? Date.parse(from) : end - hours * 3600000;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    end - start > 30 * 86400000 ||
    end > now + 30000
  )
    throw new Error("对象历史范围必须在30天内且起止时间有效");
  const seconds = Math.max(
    start < now - 7 * 86400000 ? 300 : 30,
    Math.ceil((end - start) / 1000 / 1438),
  );
  return { start: new Date(start), end: new Date(end), bucketSeconds: seconds };
}
