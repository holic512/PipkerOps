import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monitoringObservation,
  observationValue,
} from "../src/lib/monitoring-alerts";
import type { Snapshot } from "../src/lib/telemetry";
const now = Date.now();
const snapshot = (
  category: Snapshot["category"],
  data: Record<string, unknown> = {},
  series: Snapshot["series"] = [],
): Snapshot => ({
  schemaVersion: 2,
  category,
  bootId: "boot",
  sequence: 1,
  sampledAt: new Date(now).toISOString(),
  receivedAt: new Date(now).toISOString(),
  durationMs: 1,
  data,
  series,
  errors: [],
  truncated: false,
});
test("容量/inode 使用准确挂载点，过期、空值与部分采集不证明恢复", () => {
  const disk = snapshot("disks", {}, [
    { metric: "disk.percent", device: "/data", unit: "%", value: 96 },
    { metric: "disk.inodePercent", device: "/data", unit: "%", value: 91 },
  ]);
  assert.equal(monitoringObservation("diskPercent", [disk], now).value, 96);
  assert.match(
    monitoringObservation("inodePercent", [disk], now).context,
    /\/data/,
  );
  assert.equal(
    monitoringObservation("diskPercent", [disk], now + 46000).value,
    null,
  );
  const partial = monitoringObservation(
    "diskPercent",
    [{ ...disk, truncated: true }],
    now,
  );
  assert.equal(observationValue(partial, "gt", 85), 96);
  assert.equal(observationValue(partial, "gt", 99), null);
  assert.equal(observationValue(partial, "lt", 99), null);
  assert.equal(
    monitoringObservation("inodePercent", [snapshot("disks")], now).value,
    null,
  );
});
test("服务与容器异常按实际状态计数，缺数据和截断不视为正常", () => {
  const details = snapshot("details", {
    services: [{ name: "web.service", active: "failed" }],
    containers: [
      { name: "web", state: "running", health: "unhealthy", restartCount: 0 },
      { name: "stopped", state: "exited", restartCount: 0 },
    ],
  });
  assert.equal(
    monitoringObservation("serviceFailure", [details], now).value,
    1,
  );
  assert.equal(
    monitoringObservation("containerFailure", [details], now).value,
    1,
  );
  assert.equal(
    monitoringObservation("containerFailure", [snapshot("details")], now).value,
    null,
  );
  assert.equal(
    observationValue(
      monitoringObservation(
        "containerFailure",
        [{ ...details, data: { containers: [] }, truncated: true }],
        now,
      ),
      "gt",
      0,
    ),
    null,
  );
});
test("采集失效含未采样和过期，旧版仅按实际能力检查", () => {
  assert.equal(monitoringObservation("collectionFailure", [], now).value, 1);
  assert.equal(
    monitoringObservation("collectionFailure", [snapshot("fast")], now).value,
    3,
  );
  assert.equal(
    monitoringObservation("collectionFailure", [snapshot("legacy")], now).value,
    0,
  );
  assert.equal(
    monitoringObservation(
      "collectionFailure",
      [snapshot("legacy")],
      now + 46000,
    ).value,
    1,
  );
});
