import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availability,
  diagnosticAdvice,
  failureState,
  hostMetricRows,
} from "../src/lib/monitoring-availability";
import { telemetryFrame, type Snapshot } from "../src/lib/telemetry";
const snapshot: Snapshot = {
  schemaVersion: 2,
  bootId: "boot",
  sequence: 1,
  category: "fast",
  sampledAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  data: {},
  durationMs: 1,
  series: [],
  errors: [],
  truncated: false,
};
test("缺采样、旧 Agent、有效零值和过期有不同状态", () => {
  const visible = hostMetricRows({
    ...snapshot,
    series: [{ metric: "memory.percent", unit: "%", device: "", value: 0 }],
  });
  assert.equal(visible.find((p) => p.metric === "memory.percent")?.value, 0);
  assert.equal(visible.find((p) => p.metric === "cpu.total")?.value, null);
  assert.equal(availability({ value: null }).state, "waiting_sample");
  assert.equal(
    availability({ value: null, snapshot, legacy: true }).state,
    "upgrade_required",
  );
  assert.equal(availability({ value: 0, snapshot }).state, "ok");
  assert.equal(
    availability({ value: 0, snapshot: { ...snapshot, stale: true } }).state,
    "stale",
  );
  assert.equal(
    availability({ value: "none", snapshot }).state,
    "not_applicable",
  );
});
test("失败容器与挂载点独立报告权限或采集错误", () => {
  assert.equal(
    availability({
      value: "",
      snapshot,
      field: "name",
      row: { fieldErrors: { name: "operation not permitted" } },
    }).state,
    "permission_denied",
  );
  assert.equal(
    availability({
      value: null,
      snapshot: {
        ...snapshot,
        errors: ["processes: other PID permission denied"],
      },
      field: "cpuPercent",
      row: { pid: 2 },
    }).state,
    "waiting_baseline",
    "其他进程失败不改变当前进程的基线状态",
  );
  assert.equal(
    availability({
      value: null,
      snapshot,
      field: "user",
      row: { fieldErrors: { user: "permission denied" } },
    }).state,
    "permission_denied",
  );
  assert.equal(
    availability({
      value: null,
      snapshot: { ...snapshot, errors: ["cpu: operation not permitted"] },
      row: { metric: "CPU 总使用率", rawMetric: "cpu.total" },
    }).state,
    "permission_denied",
  );
  assert.equal(
    availability({
      value: null,
      snapshot,
      field: "health",
      row: { inspectError: "permission denied" },
    }).state,
    "permission_denied",
  );
  assert.equal(
    availability({
      value: null,
      snapshot,
      row: { collectionError: "input/output error" },
    }).state,
    "failed",
  );
  assert.equal(
    availability({ value: "healthy", snapshot, field: "health" }).state,
    "ok",
  );
  assert.equal(failureState("systemd: not supported"), "unsupported");
  assert.match(
    diagnosticAdvice(["docker: permission denied"], true),
    /权限.*上限/,
  );
});
test("设备速率遵循采集器状态，空闲延迟不冒充零", () => {
  const s = {
    ...snapshot,
    series: [
      {
        metric: "io.read",
        device: "vda1",
        unit: "B/s",
        value: null,
        status: "unsupported" as const,
        reason: "diskseq unavailable",
      },
    ],
  };
  const missing = availability({
    value: null,
    snapshot: s,
    row: { name: "vda1" },
    field: "readPerSecond",
  });
  assert.equal(missing.state, "unsupported");
  assert.equal(missing.reason, "diskseq unavailable");
  assert.equal(
    availability({
      value: null,
      snapshot,
      row: { readIOPS: 0 },
      field: "readLatency",
    }).state,
    "not_applicable",
  );
});
test("新状态为可选协议扩展且保留历史空值", () => {
  const frame = telemetryFrame.parse({
    ...snapshot,
    series: [
      {
        metric: "io.read",
        device: "vda1",
        unit: "B/s",
        value: null,
        status: "waiting_baseline",
        reason: "need two samples",
      },
    ],
  });
  assert.equal(frame.series[0].value, null);
  assert.equal(frame.series[0].status, "waiting_baseline");
  assert.equal(telemetryFrame.parse(snapshot).series.length, 0);
  assert.equal(
    telemetryFrame.safeParse({
      ...frame,
      series: [{ ...frame.series[0], status: "invented" }],
    }).success,
    false,
  );
});
