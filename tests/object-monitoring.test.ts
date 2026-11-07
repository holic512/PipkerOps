import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameObservations,
  processObjectId,
  objectHistoryResolution,
} from "../src/lib/object-monitoring";
import { stateSlices, insertSamplingGaps } from "../src/lib/monitoring-visuals";
import type { TelemetryFrame } from "../src/lib/telemetry";
test("进程身份保留启动ticks精度，容器仅接受完整ID，旧Agent不生成对象历史", () => {
  const process = {
    bootId: "boot",
    pid: 4,
    startTicks: "90071992547409931234",
    name: "worker",
    cpuPercent: 280,
  };
  const frame: TelemetryFrame = {
    schemaVersion: 2,
    bootId: "boot",
    sequence: 1,
    category: "details",
    sampledAt: new Date().toISOString(),
    durationMs: 10,
    series: [],
    errors: [],
    truncated: false,
    data: {
      historyVersion: 1,
      processHistory: [process, { ...process, bootId: "other" }],
      containers: [{ id: "abc" }, { id: "a".repeat(64), state: "running" }],
    },
  };
  const rows = frameObservations(frame, 30000);
  assert.equal(rows.filter((r) => r.kind === "process").length, 1);
  assert.equal(
    rows.find((r) => r.kind === "process")?.objectId,
    processObjectId(process),
  );
  assert.equal(
    rows.find((r) => r.kind === "process")?.metrics.cpuPercent.value,
    280,
  );
  assert.equal(rows.filter((r) => r.kind === "container").length, 1);
  assert.equal(
    rows.find((r) => r.kind === "container")?.metrics.cpuPercent.value,
    null,
  );
  assert.equal(
    frameObservations(
      { ...frame, data: { ...frame.data, historyVersion: undefined } },
      30000,
    ).length,
    1,
  );
});
test("30天查询最多1440点且拒绝无效时间窗", () => {
  const now = Date.now();
  const r = objectHistoryResolution(720, undefined, undefined, now);
  assert.ok(
    Math.ceil((r.end.getTime() - r.start.getTime()) / 1000 / r.bucketSeconds) <=
      1440,
  );
  assert.throws(() => objectHistoryResolution(721));
  assert.throws(() =>
    objectHistoryResolution(
      1,
      new Date(now).toISOString(),
      new Date(now - 1000).toISOString(),
    ),
  );
});
test("状态环区分失败、不健康、停止、未配置检查；采样缺口不补零", () => {
  const slices = stateSlices(
    [
      { state: "dead" },
      { state: "running", health: "unhealthy" },
      { state: "exited" },
      { state: "running", health: "none" },
    ],
    "container",
  );
  assert.deepEqual(
    slices.map((s) => s.name),
    ["失败", "不健康", "停止 / 暂停", "未配置健康检查"],
  );
  const points = insertSamplingGaps(
    [
      { recordedAt: "2026-11-01T00:00:00Z", value: 0 },
      { recordedAt: "2026-11-01T00:01:00Z", value: 5 },
    ],
    30000,
  );
  assert.equal(points[0].value, 0);
  assert.equal(points[1].value, null);
});
