/** Isolated SQL volume fixture; does not claim long-running Agent acceptance. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import {
  detailHistoryQuery,
  type MetricKind,
} from "../src/lib/services/metric-details";

export async function verifyDeviceHistoryCapacity(pool: Pool) {
  await pool.query(`DELETE FROM "Task" WHERE "nodeId"='fixture-node'; DELETE FROM "Node" WHERE id='fixture-node'; TRUNCATE "MetricMaintenanceState";
    INSERT INTO "Node" (id,name,"updatedAt") SELECT 'capacity-'||n,'capacity-'||n,now() FROM generate_series(1,50) n;
    INSERT INTO "MetricDeviceHourly"
    SELECT 'capacity-'||n,kind,device,direction,date_trunc('hour',now())-interval '30 days'+h*interval '1 hour',240,0,
      CASE WHEN kind='disk' THEN 40*240 WHEN kind='network' THEN CASE WHEN direction='接收' THEN 10 ELSE 20 END*3600 ELSE CASE WHEN direction='读取' THEN 20 ELSE 40 END*3600 END,
      CASE WHEN kind='disk' THEN 240 ELSE 3600 END
    FROM generate_series(1,50) n CROSS JOIN generate_series(0,719) h CROSS JOIN (
      SELECT 'disk' AS kind,'/mnt/disk'||d AS device,'使用率' AS direction FROM generate_series(0,7) d
      UNION ALL SELECT 'network','eth'||d,direction FROM generate_series(0,3) d CROSS JOIN (VALUES ('接收'),('发送')) x(direction)
      UNION ALL SELECT 'io','disk'||d,direction FROM generate_series(0,7) d CROSS JOIN (VALUES ('读取'),('写入')) x(direction)
    ) devices;
    INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent")
    SELECT 'capacity-'||n||'-'||s,'capacity-'||n,date_trunc('hour',now())-interval '1 hour'+s*interval '15 seconds',
      jsonb_build_object(
        'disk',(SELECT jsonb_agg(jsonb_build_object('mountpoint','/mnt/disk'||d,'usedPercent',40)) FROM generate_series(0,7) d),
        'network',(SELECT jsonb_agg(jsonb_build_object('name','eth'||d,'bytesRecv',(s+1)*150,'bytesSent',(s+1)*300)) FROM generate_series(0,3) d),
        'io',(SELECT jsonb_object_agg('disk'||d,jsonb_build_object('readBytes',(s+1)*300,'writeBytes',(s+1)*600)) FROM generate_series(0,7) d),
        'deviceIdentity',jsonb_build_object('network',(SELECT jsonb_object_agg('eth'||d,'boot:if-'||d) FROM generate_series(0,3) d),'io',(SELECT jsonb_object_agg('disk'||d,'boot:disk-'||d) FROM generate_series(0,7) d))
      ),20,40
    FROM generate_series(1,50) n CROSS JOIN generate_series(-1,239) s;
    INSERT INTO "MetricMaintenanceState" (id,"aggregatedThrough","deviceAggregatedThrough",summary)
    VALUES ('metrics',date_trunc('hour',now())-interval '24 hours',date_trunc('hour',now())-interval '24 hours',jsonb_build_object('rawCutoff',date_trunc('hour',now())-interval '30 days'));
    ANALYZE "MetricDeviceHourly"; ANALYZE "MetricSample";`);
  const before = await measure(pool);
  assert.equal(before.summaryRows, 50 * 32 * 24 * 30);
  assert.equal(before.rawRows, 50 * 241);
  const queryNow = new Date();
  const snapshots = new Map<string, string>();
  const queries: {
    kind: MetricKind;
    hours: number;
    device: string;
    ms: number;
    points: number;
    afterMaintenanceMs?: number;
  }[] = [];
  for (const kind of ["disk", "network", "io"] as const) {
    for (const hours of [168, 720, 8760]) {
      const device =
        kind === "disk" ? "/mnt/disk0" : kind === "network" ? "eth0" : "disk0";
      const q = detailHistoryQuery(
        "capacity-25",
        kind,
        hours,
        device,
        queryNow,
      );
      const started = performance.now();
      const { rows } = await pool.query(q.query.text, q.query.values);
      const result = rows[0] as {
        devices: string[];
        device: string | null;
        points: { direction: string; value: number | null }[];
      };
      const ms = performance.now() - started;
      assert.equal(result.device, device);
      assert.equal(result.devices.length, kind === "network" ? 4 : 8);
      for (const direction of new Set(result.points.map((p) => p.direction))) {
        const points = result.points.filter((p) => p.direction === direction);
        assert.ok(points.length <= 720);
        const valid = points.filter((p) => p.value !== null);
        assert.ok(valid.length > 0);
        const expected =
          kind === "disk"
            ? 40
            : ["接收"].includes(direction)
              ? 10
              : direction === "写入"
                ? 40
                : 20;
        assert.ok(
          valid.every((p) => p.value === expected),
          `${kind}/${direction} weighted value changed`,
        );
      }
      snapshots.set(`${kind}:${hours}`, JSON.stringify(result));
      queries.push({
        kind,
        hours,
        device,
        ms: Math.round(ms),
        points: result.points.length,
      });
    }
  }
  const started = performance.now();
  const maintenance = (
    await pool.query<{
      result: { skipped: boolean; deviceAggregatedHours: number };
    }>("SELECT pipkerops_maintain_metrics() AS result")
  ).rows[0].result;
  const maintenanceMs = Math.round(performance.now() - started);
  assert.equal(maintenance.skipped, false);
  assert.equal(maintenance.deviceAggregatedHours, 50 * 32 * 2);
  const after = await measure(pool);
  assert.equal(
    after.summaryRows,
    before.summaryRows,
    "tail upsert must not duplicate summaries",
  );
  for (const query of queries) {
    const q = detailHistoryQuery(
      "capacity-25",
      query.kind,
      query.hours,
      query.device,
      queryNow,
    );
    const started = performance.now();
    const result = (await pool.query(q.query.text, q.query.values)).rows[0];
    query.afterMaintenanceMs = Math.round(performance.now() - started);
    assert.equal(
      JSON.stringify(result),
      snapshots.get(`${query.kind}:${query.hours}`),
      "maintenance must preserve merged query results",
    );
  }
  console.log(
    JSON.stringify({
      fixture:
        "50 nodes × 30 days × 32 device-directions; raw tail only 1h+15s, not a 30-day raw corpus",
      before,
      after,
      maintenanceMs,
      queries,
    }),
  );
}

async function measure(pool: Pool) {
  const result = (
    await pool.query<{
      summaryRows: string;
      rawRows: string;
      summaryBytes: string;
      rawBytes: string;
      postgres: string;
    }>(`SELECT
    (SELECT count(*) FROM "MetricDeviceHourly") AS "summaryRows",
    (SELECT count(*) FROM "MetricSample") AS "rawRows",
    pg_total_relation_size('"MetricDeviceHourly"') AS "summaryBytes",
    (SELECT sum(pg_total_relation_size(relid)) FROM pg_partition_tree('"MetricSample"') WHERE isleaf) AS "rawBytes",
    current_setting('server_version') AS postgres`)
  ).rows[0];
  return {
    ...result,
    summaryRows: Number(result.summaryRows),
    rawRows: Number(result.rawRows),
    summaryBytes: Number(result.summaryBytes),
    rawBytes: Number(result.rawBytes),
  };
}
