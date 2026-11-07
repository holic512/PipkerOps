import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterProjection,
  clusterTarget,
} from "../src/lib/cluster-monitoring";
import type { Snapshot } from "../src/lib/telemetry";
const now = Date.now();
const node = {
  id: "n",
  name: "node",
  labels: [],
  connected: true,
  metrics: [],
};
const snapshot = (category: Snapshot["category"], age = 0): Snapshot => ({
  schemaVersion: 2,
  category,
  bootId: "b",
  sequence: 1,
  sampledAt: new Date(now - age).toISOString(),
  receivedAt: new Date(now - age).toISOString(),
  durationMs: 1,
  series: [],
  data: { cpuPercent: 95, memoryPercent: 0 },
  errors: [],
  truncated: false,
});
test("静态更新不能掩盖资源长期无采样，也不将旧 CPU 排入排行", () => {
  const row = clusterProjection(
    node,
    [snapshot("fast", 360000), snapshot("static")],
    now,
  );
  assert.equal(row.longMissing, true);
  assert.equal(row.cpuPercent, null);
  assert.equal(row.lastSampleAt, new Date(now - 360000).toISOString());
  assert.equal(
    clusterProjection(node, [snapshot("static")], now).longMissing,
    true,
  );
});
test("新鲜持久快照可排行，有效零值保留，离线和未来异常时钟不当成正常", () => {
  const row = clusterProjection(node, [snapshot("fast")], now);
  assert.equal(row.cpuPercent, 95);
  assert.equal(row.memoryPercent, 0);
  assert.ok(row.reasons.includes("CPU 使用率偏高"));
  assert.equal(
    clusterProjection({ ...node, connected: false }, [snapshot("fast")], now)
      .cpuPercent,
    null,
  );
  assert.equal(
    clusterProjection(node, [snapshot("fast", -360000)], now).cpuPercent,
    null,
  );
});
test("资源历史回退不以零冒充未知；旧版和时间口径明确", () => {
  const old = {
    ...node,
    metrics: [
      { recordedAt: new Date(now), cpuPercent: 0, memoryPercent: null },
    ],
  };
  const row = clusterProjection(old, [], now);
  assert.equal(row.cpuPercent, 0);
  assert.equal(row.memoryPercent, null);
  assert.equal(row.longMissing, false);
  const legacy = clusterProjection(node, [snapshot("legacy")], now);
  assert.equal(legacy.cpuPercent, 95);
});
test("排行定位选择正确分类，失效采样与服务异常保留对应入口", () => {
  const healthy = { longMissing: false, observations: {} };
  assert.equal(clusterTarget(healthy, "cpuPercent"), "live");
  assert.equal(clusterTarget(healthy, "memoryPercent"), "live");
  assert.equal(clusterTarget(healthy, "diskPercent"), "resources");
  assert.equal(
    clusterTarget({ ...healthy, longMissing: true }, "cpuPercent"),
    "details",
  );
  assert.equal(
    clusterTarget(
      { ...healthy, observations: { serviceFailure: { value: 1 } } },
      "cpuPercent",
    ),
    "services",
  );
});
