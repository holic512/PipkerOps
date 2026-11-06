import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import {
  telemetryFrame,
  historyPayload,
  acceptSequence,
  snapshotFresh,
  numericPercent,
  preferredSnapshots,
  legacySeries,
  withLegacySeries,
} from "../src/lib/telemetry";
import { telemetryQueue, legacyFrame } from "../src/lib/services/telemetry";
import { methodSchemas, mutation } from "../src/lib/services/contracts";
import { numericHistoryQuery } from "../src/lib/services/telemetry-history";
test("旧版采样把实际 CPU、内存和文件系统指标映射为有单位的数值序列", () => {
  const payload = {
    cpuPercent: 12.5,
    memoryPercent: 50,
    memory: {
      used: 1024,
      available: 1024,
      free: 128,
      cached: 512,
      buffers: 64,
    },
    disk: [
      {
        device: "/dev/vda",
        mountpoint: "/",
        usedPercent: 25,
        used: 100,
        free: 300,
      },
      {
        device: "/dev/vda",
        mountpoint: "/data",
        usedPercent: 75,
        used: 300,
        free: 100,
      },
    ],
    network: [{ name: "eth0", bytesRecv: 9999, bytesSent: 8888 }],
    io: { vda: { readBytes: 10000, writeBytes: 20000 } },
    collectionErrors: ["docker: not installed"],
  };
  const frame = legacyFrame(payload);
  assert.deepEqual(frame.data, payload);
  assert.deepEqual(frame.errors, payload.collectionErrors);
  assert.deepEqual(frame.series.slice(0, 3), [
    { metric: "cpu.total", device: "", unit: "%", value: 12.5 },
    { metric: "memory.percent", device: "", unit: "%", value: 50 },
    { metric: "memory.used", device: "", unit: "B", value: 1024 },
  ]);
  assert.deepEqual(
    frame.series.filter((point) => point.metric === "disk.percent"),
    [
      { metric: "disk.percent", device: "/", unit: "%", value: 25 },
      { metric: "disk.percent", device: "/data", unit: "%", value: 75 },
    ],
  );
  assert.equal(frame.series.length, 13);
  assert.equal(
    frame.series.some((point) =>
      /^(network|io|load|swap)\./.test(point.metric),
    ),
    false,
  );
  // Cached and durable snapshots created before this fix still render gauges.
  assert.deepEqual(
    withLegacySeries({ ...frame, series: [] }).series,
    frame.series,
  );
  assert.deepEqual(withLegacySeries(frame), frame);
});

test("旧版兼容保留缺口和已有序列，不从缺失字段或累计计数构造数值", () => {
  const points = legacySeries({
    cpuPercent: NaN,
    memoryPercent: null,
    memory: { usedPercent: 50, used: 0, free: -1, cached: "1024" },
    swap: { usedPercent: 0, used: 0, sin: 100, sout: 200 },
    load: { load1: 2, load5: null, load15: Infinity },
    disk: [
      { device: "vda", usedPercent: 50 },
      { mountpoint: "/", usedPercent: 101, used: null },
      { mountpoint: "/", usedPercent: 50 },
    ],
  });
  const point = (metric: string) => points.find((p) => p.metric === metric);
  assert.equal(point("cpu.total")?.value, null);
  assert.equal(point("memory.percent")?.value, null);
  assert.equal(point("memory.used")?.value, 0);
  assert.equal(point("memory.free")?.value, null);
  assert.equal(point("memory.cached")?.value, null);
  assert.equal(point("memory.available"), undefined);
  assert.equal(point("swap.used")?.value, 0);
  assert.equal(point("swap.in"), undefined);
  assert.equal(point("swap.out"), undefined);
  assert.equal(point("load.1")?.unit, "");
  assert.equal(point("load.1")?.value, 2);
  assert.equal(point("load.5")?.value, null);
  assert.equal(point("load.15")?.value, null);
  assert.deepEqual(
    points.filter((p) => p.metric === "disk.percent"),
    [{ metric: "disk.percent", device: "/", unit: "%", value: null }],
  );
  assert.deepEqual(
    legacySeries({}).map((p) => p.value),
    [null, null],
  );
  const frame = legacyFrame({ cpuPercent: 50 });
  const explicit = { metric: "cpu.total", device: "", unit: "%", value: null };
  assert.deepEqual(
    withLegacySeries({ ...frame, series: [explicit] }).series[0],
    explicit,
  );
  const modern = { ...frame, category: "fast" as const, series: [] };
  assert.equal(withLegacySeries(modern), modern);
});

test("历史回退保持磁盘可用空间口径，v2 available 优先于总空闲 free", () => {
  const points = legacySeries({
    disk: [
      { mountpoint: "/legacy", free: 100 },
      { mountpoint: "/modern", free: 120, available: 100 },
      { mountpoint: "/missing", free: 120, available: null },
    ],
  }).filter((point) => point.metric === "disk.free");
  assert.deepEqual(points, [
    { metric: "disk.free", device: "/legacy", unit: "B", value: 100 },
    { metric: "disk.free", device: "/modern", unit: "B", value: 100 },
    { metric: "disk.free", device: "/missing", unit: "B", value: null },
  ]);
});

test("采样部分失败、首次CPU缺基线、乱序与新启动身份", () => {
  const frame = telemetryFrame.parse({
    schemaVersion: 2,
    bootId: "boot",
    sequence: 2,
    category: "fast",
    sampledAt: new Date().toISOString(),
    durationMs: 1,
    data: { memoryPercent: 50 },
    errors: ["cpu unavailable"],
  });
  const snapshot = { ...frame, receivedAt: new Date().toISOString() };
  assert.equal(numericPercent(frame.data.cpuPercent), null);
  assert.equal(numericPercent(NaN), null);
  assert.equal(acceptSequence(snapshot, { ...frame, sequence: 1 }), false);
  assert.equal(
    acceptSequence(snapshot, { ...frame, bootId: "new", sequence: 0 }),
    true,
  );
  assert.equal(snapshotFresh(snapshot, Date.now() + 21000), false);
  assert.deepEqual(
    preferredSnapshots([
      snapshot,
      {
        ...snapshot,
        category: "legacy",
        receivedAt: "2000-01-01T00:00:00.000Z",
      },
    ]).map((s) => s.category),
    ["fast"],
  );
  assert.deepEqual(
    historyPayload([
      {
        ...snapshot,
        data: {
          cpuPercent: 10,
          processes: [{}],
          ports: [{}],
          containers: [{}],
        },
      },
    ]),
    { cpuPercent: 10 },
  );
  assert.doesNotThrow(() => legacyFrame({ memoryPercent: 50 }));
  for (const method of ["nodes.get", "nodes.summary", "nodes.snapshot"])
    assert.equal(mutation(method), false);
  assert.throws(() =>
    methodSchemas["nodes.snapshot"].parse({ nodeId: "n", category: "private" }),
  );
});
test("指标队列每分类只保留最新待处理帧，错误不阻止后续处理", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: number[] = [];
  const errors: unknown[] = [];
  const q = telemetryQueue(
    async (frame) => {
      seen.push(frame.sequence);
      if (frame.sequence === 1) await gate;
      if (frame.sequence === 4) throw new Error("disk failed");
    },
    (e) => errors.push(e),
  );
  const base = legacyFrame({});
  q.push({ ...base, sequence: 1 });
  for (let i = 2; i <= 100; i++) q.push({ ...base, sequence: i });
  q.push({ ...base, category: "disks", sequence: 4 });
  q.push({ ...base, sequence: 2 }); // An older queued frame must not replace 100.
  assert.equal(q.size(), 2);
  release();
  await q.idle();
  assert.deepEqual(seen, [1, 100, 4]);
  assert.equal(errors.length, 1);
});
test("全部迁移、Redis切换清表、可空指标与新历史维护事务", async () => {
  const db = new PGlite();
  try {
    const root = new URL("../prisma/migrations/", import.meta.url);
    for (const dir of (await readdir(root)).filter((s) => /^\d/.test(s)).sort())
      await db.exec(
        await readFile(new URL(`${dir}/migration.sql`, root), "utf8"),
      );
    assert.equal(
      (
        await db.query<{ table: string | null }>(
          `SELECT to_regclass('public."Session"')::text AS table`,
        )
      ).rows[0].table,
      null,
    );
    await db.exec(
      `INSERT INTO "Node" (id,name,"updatedAt") VALUES ('test','test',now());INSERT INTO "MetricSample" (id,"nodeId","cpuPercent","memoryPercent") VALUES ('partial','test',NULL,20);`,
    );
    await db.query(
      `INSERT INTO "TelemetrySample" VALUES ('test',date_trunc('hour',now())-interval '2 hours',$1::jsonb)`,
      [
        JSON.stringify([
          { metric: "load.1", device: "", unit: "", value: 2 },
          { metric: "swap.in", device: "", unit: "B/s", value: null },
        ]),
      ],
    );
    await db.exec(`SELECT pipkerops_maintain_telemetry();`);
    const result = await db.query<{
      metric: string;
      mean: number | null;
      gapCount: number;
    }>(`SELECT metric,mean,"gapCount" FROM "TelemetryHourly" ORDER BY metric`);
    assert.equal(result.rows[0].mean, 2);
    assert.equal(result.rows[1].mean, null);
    assert.equal(result.rows[1].gapCount, 1);
    for (const hours of [24, 168, 8760]) {
      const query = numericHistoryQuery("test", "load.1", hours);
      const points = await db.query<{ value: number | null }>(
        query.query.text,
        query.query.values,
      );
      assert.equal(points.rows.length, 1);
      assert.equal(points.rows[0].value, 2);
    }
    const gap = numericHistoryQuery("test", "swap.in", 24);
    assert.equal(
      (
        await db.query<{ value: number | null }>(
          gap.query.text,
          gap.query.values,
        )
      ).rows[0].value,
      null,
    );
    await db.exec(`SELECT pipkerops_maintain_telemetry();`);
    assert.equal(
      (
        await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "TelemetryHourly"`,
        )
      ).rows[0].count,
      2,
    );
    await db.exec(`DELETE FROM "Node" WHERE id='test'`);
    assert.equal(
      (
        await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "TelemetrySample"`,
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await db.close();
  }
});
