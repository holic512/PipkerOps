import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { nativeMonitoringDb } from "./helpers/native-monitoring-db";
import { frameObservations } from "../src/lib/object-monitoring";
import { objectHistory } from "../src/lib/services/object-monitoring";
import type { TelemetryFrame } from "../src/lib/telemetry";

test(
  "1/10/50节点隔离容量：有界对象写入量与指定对象暖查询p95",
  { timeout: 180000 },
  async () => {
    const f = await nativeMonitoringDb();
    try {
      const frame: TelemetryFrame = {
        schemaVersion: 2,
        bootId: "capacity",
        sequence: 1,
        category: "details",
        sampledAt: new Date().toISOString(),
        durationMs: 30,
        series: [],
        errors: [],
        truncated: true,
        data: {
          historyVersion: 1,
          processHistory: Array.from({ length: 60 }, (_, i) => ({
            bootId: "capacity",
            pid: i + 1,
            startTicks: "100",
            name: `worker-${i}`,
            cpuPercent: i * 3,
            memoryPercent: i,
            rss: 4096,
            vms: 8192,
            threads: 3,
            readRate: 200,
            writeRate: 100,
            intervalMs: 30000,
          })),
          containers: Array.from({ length: 200 }, (_, i) => ({
            id: i.toString(16).padStart(64, "0"),
            name: `web-${i}`,
            state: "running",
            health: "none",
            restartCount: 0,
            metrics: {
              cpuPercent: 1,
              memoryPercent: 3,
              memoryUsed: 4096,
              memoryLimit: 8192,
              networkRecv: 200,
              networkSent: 100,
              ioRead: 300,
              ioWrite: 10,
              intervalMs: 30000,
            },
          })),
          services: Array.from({ length: 200 }, (_, i) => ({
            name: `web-${i}.service`,
            active: "active",
            sub: "running",
          })),
        },
      };
      const rows = frameObservations(frame, 30000);
      const nodes = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          f.prisma.node.create({ data: { name: `capacity-${i}` } }),
        ),
      );
      const evidence = [];
      let filled = 0;
      for (const count of [1, 10, 50]) {
        const begin = performance.now();
        await f.pool.query(
          `INSERT INTO "MonitoringSample" ("nodeId",kind,"objectId","recordedAt","bootId",identity,state,coverage,reason,metrics)
        SELECT n,kind,"objectId",now()-i*interval '30 seconds','capacity',identity,state,coverage,reason,metrics
        FROM unnest($1::text[]) n CROSS JOIN generate_series(1,120) i CROSS JOIN jsonb_to_recordset($2::jsonb) x(kind text,"objectId" text,identity jsonb,state text,coverage text,reason text,metrics jsonb)`,
          [nodes.slice(filled, count).map((n) => n.id), JSON.stringify(rows)],
        );
        const writeMs = performance.now() - begin;
        filled = count;
        const durations = [];
        const query = () =>
          objectHistory(
            { userId: "unused", role: "ADMIN" },
            {
              nodeId: nodes[count - 1].id,
              kind: "process",
              metric: "cpuPercent",
              objectIds: ["capacity:1:100"],
              hours: 1,
            },
          );
        await query();
        for (let i = 0; i < 20; i++) {
          const at = performance.now();
          const result = await query();
          durations.push(performance.now() - at);
          assert.ok(result.series[0].points.some((p) => p.value === 0));
        }
        durations.sort((a, b) => a - b);
        const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
        const storage = await f.pool.query(
          `SELECT sum(pg_total_relation_size(relid))::text AS bytes FROM pg_partition_tree('"MonitoringSample"') WHERE isleaf`,
        );
        const storedBytes = Number(storage.rows[0].bytes);
        evidence.push({
          nodes: count,
          samplesPerNode: rows.length * 120,
          observationRowsPerDay: count * rows.length * 2880,
          writeMs,
          storedBytes,
          estimatedRawBytesPerDay: Math.round(storedBytes * 24),
          warmQueryP95Ms: p95,
          warmQueries: 20,
        });
        assert.ok(
          p95 <= 500,
          `warm p95 ${p95}ms exceeds 500ms at ${count} nodes`,
        );
      }
      await f.evidence("capacity.json", {
        synthetic: true,
        windowMinutes: 60,
        cadenceSeconds: 30,
        includesIndexes: true,
        notes:
          "日磁盘为原始表及索引线性估算；不代表Linux实机、WAL、备份或30天聚合表容量",
        measurements: evidence,
      });
      console.log(JSON.stringify(evidence));
      console.log(`Capacity evidence: ${f.directory}`);
    } finally {
      await f.close();
    }
  },
);
