import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abnormalRow,
  changeHistoryMetric,
  exploreRows,
  rowHistory,
  resourceWarning,
} from "../src/lib/monitoring-explorer";

test("明细按数值排序且缺失值始终靠后，搜索与异常筛选共同生效", () => {
  const rows = [
    { name: "worker-a", pid: 1, cpuPercent: 90 },
    { name: "worker-b", pid: 2, cpuPercent: null },
    { name: "idle", pid: 3, cpuPercent: 2 },
  ];
  assert.deepEqual(
    exploreRows(rows, "process", "", false, "cpuPercent:desc", "").map(
      (r) => r.pid,
    ),
    [1, 3, 2],
  );
  assert.deepEqual(
    exploreRows(rows, "process", "", false, "cpuPercent:asc", "").map(
      (r) => r.pid,
    ),
    [3, 1, 2],
  );
  assert.deepEqual(
    exploreRows(rows, "process", "worker", true, "cpuPercent:desc", "").map(
      (r) => r.pid,
    ),
    [1],
  );
  assert.equal(rows[0].pid, 1);
});
test("服务失败、容器不健康和累计重启可定位；正常停止容器不误报", () => {
  assert.equal(resourceWarning("cpu.total", 85), "使用率偏高（≥85%）");
  assert.equal(resourceWarning("cpu.total", null), null);
  assert.equal(
    resourceWarning("network.recv", 1000000),
    null,
    "吞吐量不是使用率",
  );
  assert.equal(
    resourceWarning("load.1", 8, {
      series: [
        { metric: "load.normalized", device: "", unit: "%", value: 120 },
      ],
    } as import("../src/lib/telemetry").Snapshot),
    "归一化负载偏高（≥100%）",
  );
  assert.equal(abnormalRow({ active: "failed" }, "service"), true);
  assert.equal(abnormalRow({ health: "unhealthy" }, "container"), true);
  assert.equal(abnormalRow({ restartCount: 3 }, "container"), true);
  assert.equal(
    abnormalRow({ state: "exited", restartCount: 0 }, "container"),
    false,
  );
});
test("设备筛选与历史联动使用挂载点和准确设备名称，原始指标名不依赖翻译", () => {
  const selected = { metric: "network.recv", device: "eth1", hours: 24 };
  assert.deepEqual(changeHistoryMetric(selected, "network.sent"), {
    ...selected,
    metric: "network.sent",
  });
  assert.deepEqual(changeHistoryMetric(selected, "cpu.total"), {
    ...selected,
    metric: "cpu.total",
    device: "",
  });
  assert.deepEqual(changeHistoryMetric(selected, "io.read"), {
    ...selected,
    metric: "io.read",
    device: undefined,
  });
  assert.equal(rowHistory({}, "disk"), undefined);
  const rows = [
    { device: "/dev/vda1", mountpoint: "/" },
    { device: "/dev/vda1", mountpoint: "/data" },
  ];
  assert.deepEqual(exploreRows(rows, "disk", "", false, "", "/data"), [
    rows[1],
  ]);
  assert.deepEqual(rowHistory(rows[1], "disk"), {
    metric: "disk.percent",
    device: "/data",
  });
  assert.deepEqual(rowHistory({ name: "eth0" }, "network"), {
    metric: "network.recv",
    device: "eth0",
  });
  assert.deepEqual(rowHistory({ name: "vda1" }, "io"), {
    metric: "io.read",
    device: "vda1",
  });
  assert.deepEqual(
    rowHistory({ metric: "CPU 总使用率", rawMetric: "cpu.total" }),
    { metric: "cpu.total", device: "" },
  );
});
