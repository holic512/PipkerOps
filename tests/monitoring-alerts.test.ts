import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monitoringObservation,
  observationValue,
} from "../src/lib/monitoring-alerts";
import type { Snapshot } from "../src/lib/telemetry";
import {
  activeContainerMetric,
  assessContainer,
} from "../src/lib/container-monitoring";
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

test("当前容器异常区分一次性任务结果、近期重启与历史累计", () => {
  const init = {
    name: "ocs-answer-hub-init-1",
    lifecycle: "oneshot",
    state: "exited",
    health: "unhealthy",
    restartCount: 0,
    exitCode: 0,
  };
  const redis = {
    name: "pipker-databases-redis-1",
    state: "running",
    health: "healthy",
    restartCount: 8,
    recentRestartCount: 0,
    restartWindowComplete: true,
  };
  const observe = (...containers: Record<string, unknown>[]) =>
    monitoringObservation(
      activeContainerMetric,
      [snapshot("details", { containers })],
      now,
    );
  assert.equal(observe(init, redis).value, 0);
  assert.equal(assessContainer(init).status, "completed");
  assert.equal(
    assessContainer({ ...init, lifecycle: undefined }).status,
    "failure",
  );
  assert.match(
    observe({ ...init, exitCode: 1 }, redis).context,
    /执行失败（退出码 1）/,
  );
  assert.equal(observe({ ...init, exitCode: undefined }).value, null);
  assert.equal(observe({ ...redis, restartWindowComplete: false }).value, null);
  assert.equal(
    observe({ ...redis, restartWindowComplete: undefined }).value,
    null,
  );
  const partial = observe(
    { ...redis, restartWindowComplete: false, recentRestartCount: 3 },
    { state: "running", health: "healthy", restartCount: 8 },
  );
  assert.match(partial.context, /近 5 分钟重启 至少 3 次/);
  assert.equal(observationValue(partial, "gt", 0), 1);
  assert.equal(observationValue(partial, "lt", 2), null);
  assert.match(
    observe({ ...redis, health: "unhealthy" }).context,
    /健康检查失败/,
  );
  assert.match(observe({ ...redis, state: "restarting" }).context, /正在重启/);
  assert.match(observe({ ...redis, state: "dead" }).context, /dead/);
});
