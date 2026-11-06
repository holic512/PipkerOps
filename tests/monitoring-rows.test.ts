import { test } from "node:test";
import assert from "node:assert/strict";
import { monitoringRowKeys } from "../src/lib/monitoring-rows";
test("同一进程的多个监听端点、IPv4/IPv6、协议及重复记录不会产生重复行键", () => {
  const rows = [
    { pid: 1500, address: "0.0.0.0", port: 80, status: "LISTEN" },
    { pid: 1500, address: "0.0.0.0", port: 443, status: "LISTEN" },
    { pid: 1500, address: "::", port: 80, status: "LISTEN" },
    { pid: 1500, address: "0.0.0.0", port: 80, status: "UDP" },
    { pid: 1500, address: "0.0.0.0", port: 80, status: "LISTEN" },
  ];
  const keys = monitoringRowKeys(rows);
  assert.equal(new Set(keys).size, rows.length);
  const changed = [rows[2], { ...rows[0], bytes: 999 }, rows[1], rows[3]];
  assert.deepEqual(monitoringRowKeys(changed), [
    keys[2],
    keys[0],
    keys[1],
    keys[3],
  ]);
});
test("设备、指标和进程键不依赖采样值及排序，多个挂载点不按同一设备名合并", () => {
  const rows = [
    { device: "/dev/vda", mountpoint: "/" },
    { device: "/dev/vda", mountpoint: "/data" },
    { metric: "cpu.total", device: "", value: 1 },
    { metric: "memory.percent", device: "", value: 1 },
    { pid: 1139, name: "worker", cpuPercent: 1 },
  ];
  const keys = monitoringRowKeys(rows);
  assert.equal(new Set(keys).size, rows.length);
  const reversed = rows
    .map((row) => ({ ...row, value: 42, cpuPercent: 50 }))
    .reverse();
  assert.deepEqual(monitoringRowKeys(reversed), [...keys].reverse());
});
