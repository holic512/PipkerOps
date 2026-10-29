/**
 * @file metric-details.ts
 * @project PipkerOps
 * @module metric-history-details
 * @description 从原始采样与长期小时摘要查询设备历史，累计计数转换为速率。
 * @logic 按窗口分桶并仅返回选中设备；计数回退、设备身份变化或采样中断保留空值，分桶内任一区间不可靠则保留缺口，按有效时长加权。
 * @dependencies Prisma SQL, authorization, retained metric samples
 * @index_tags metrics, disk, network, io, history
 * @author holic512
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { authorize, type Actor } from "../auth";
export type MetricKind = "disk" | "network" | "io";
type DetailPoint = {
  device: string;
  direction: string;
  recordedAt: string;
  value: number | null;
};
type DetailResult = {
  devices: string[];
  device: string | null;
  points: DetailPoint[];
};
export async function metricDetails(
  actor: Actor,
  nodeId: string,
  kind: MetricKind,
  hours: number,
  device?: string,
) {
  authorize(actor, "nodes:read", nodeId);
  const { query, bucketSeconds, unit } = detailHistoryQuery(
    nodeId,
    kind,
    hours,
    device,
  );
  const [result] = await db().$queryRaw<DetailResult[]>(query);
  const series = new Map<
    string,
    { name: string; points: { recordedAt: string; value: number | null }[] }
  >();
  for (const row of result.points) {
    let s = series.get(row.direction);
    if (!s) {
      s = { name: row.direction, points: [] };
      series.set(row.direction, s);
    }
    s.points.push({ recordedAt: row.recordedAt, value: row.value });
  }
  return {
    unit,
    bucketSeconds,
    devices: result.devices,
    device: result.device,
    series: [...series.values()],
  };
}

export function detailHistoryQuery(
  nodeId: string,
  kind: MetricKind,
  hours: number,
  device?: string,
  now = new Date(),
) {
  if (hours > 48) return deviceHourlyQuery(nodeId, kind, hours, device, now);
  const since = new Date(now.getTime() - hours * 3600000),
    bucketSeconds = Math.ceil((hours * 3600) / 720);
  let extraction: Prisma.Sql;
  if (kind === "disk")
    extraction = Prisma.sql`SELECT s."recordedAt", item->>'mountpoint' AS device, item->>'usedPercent' AS value, '使用率' AS direction, NULL::text AS identity
    FROM "MetricSample" s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload->'disk')='array' THEN s.payload->'disk' ELSE '[]'::jsonb END) item
    WHERE s."nodeId"=${nodeId} AND s."recordedAt">=${since}::timestamptz AND s."recordedAt"<${now}::timestamptz`;
  else if (kind === "network")
    extraction = Prisma.sql`SELECT s."recordedAt", item->>'name' AS device, item->>direction.key AS value, direction.name AS direction, s.payload->'deviceIdentity'->'network'->>(item->>'name') AS identity
    FROM "MetricSample" s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload->'network')='array' THEN s.payload->'network' ELSE '[]'::jsonb END) item
    CROSS JOIN (VALUES ('bytesRecv','接收'),('bytesSent','发送')) direction(key,name)
    WHERE s."nodeId"=${nodeId} AND s."recordedAt">=${new Date(since.getTime() - 120000)}::timestamptz AND s."recordedAt"<${now}::timestamptz`;
  else
    extraction = Prisma.sql`SELECT s."recordedAt", item.key AS device, item.value->>direction.key AS value, direction.name AS direction, s.payload->'deviceIdentity'->'io'->>item.key AS identity
    FROM "MetricSample" s CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.payload->'io')='object' THEN s.payload->'io' ELSE '{}'::jsonb END) item
    CROSS JOIN (VALUES ('readBytes','读取'),('writeBytes','写入')) direction(key,name)
    WHERE s."nodeId"=${nodeId} AND s."recordedAt">=${new Date(since.getTime() - 120000)}::timestamptz AND s."recordedAt"<${now}::timestamptz`;
  const base = Prisma.sql`WITH extracted AS (${extraction}), valid AS (
    SELECT "recordedAt", device, direction, identity, CASE WHEN length(value)<=40 AND value ~ '^[0-9]+([.][0-9]+)?$' THEN value::double precision END AS value FROM extracted
    WHERE device IS NOT NULL AND length(device) BETWEEN 1 AND 200
    ), devices AS (SELECT DISTINCT device FROM valid WHERE "recordedAt">=${since}::timestamptz ORDER BY device), chosen AS (
    SELECT device FROM devices WHERE ${device ?? null}::text IS NULL OR device=${device ?? null}::text ORDER BY device LIMIT 1
    ), selected AS (SELECT v.* FROM valid v JOIN chosen c USING(device))`;
  const points =
    kind === "disk"
      ? Prisma.sql`SELECT device,direction,date_bin(${bucketSeconds}::integer * interval '1 second',"recordedAt",${since}::timestamptz) AS "recordedAt", avg(value) AS value
    FROM selected WHERE value BETWEEN 0 AND 100 GROUP BY device,direction,3`
      : Prisma.sql`SELECT device,direction,date_bin(${bucketSeconds}::integer * interval '1 second',"recordedAt",${since}::timestamptz) AS "recordedAt",
    CASE WHEN bool_and(coalesce(identity IS NOT DISTINCT FROM previous_identity AND value>=previous AND elapsed>0 AND elapsed<=120,false))
      THEN sum(value-previous)/nullif(sum(elapsed),0) END AS value
    FROM (SELECT *,lag(value) OVER w AS previous,lag(identity) OVER w AS previous_identity,extract(epoch FROM "recordedAt"-lag("recordedAt") OVER w) AS elapsed
    FROM selected WINDOW w AS (PARTITION BY device,direction ORDER BY "recordedAt")) deltas
    WHERE "recordedAt">=${since}::timestamptz GROUP BY device,direction,3`;
  return {
    bucketSeconds,
    unit: kind === "disk" ? "%" : "B/s",
    query: Prisma.sql`${base}, points AS (${points})
    SELECT (SELECT coalesce(jsonb_agg(device ORDER BY device),'[]'::jsonb) FROM devices) AS devices,
    (SELECT device FROM chosen) AS device,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.direction,p."recordedAt"),'[]'::jsonb) FROM points p) AS points`,
  };
}

function deviceHourlyQuery(
  nodeId: string,
  kind: MetricKind,
  hours: number,
  device: string | undefined,
  now: Date,
) {
  const since = new Date(now.getTime() - hours * 3600000);
  since.setUTCMinutes(0, 0, 0);
  const bucketSeconds = Math.ceil(hours / 720) * 3600;
  return {
    unit: kind === "disk" ? "%" : "B/s",
    bucketSeconds,
    query: Prisma.sql`WITH tail_start AS (
      SELECT greatest(${since}::timestamptz,coalesce("deviceAggregatedThrough"-interval '48 hours',${since}::timestamptz),coalesce((summary->>'rawCutoff')::timestamptz,${since}::timestamptz)) AS at
      FROM "MetricMaintenanceState" WHERE id='metrics'
    ), tail AS (
      SELECT * FROM pipkerops_device_hours(coalesce((SELECT at FROM tail_start),${since}::timestamptz),${now}::timestamptz,${nodeId},${kind})
    ), merged AS (
      SELECT * FROM tail
      UNION ALL
      SELECT h.* FROM "MetricDeviceHourly" h WHERE h."nodeId"=${nodeId} AND h.kind=${kind} AND h."bucketAt">=${since}::timestamptz AND h."bucketAt"<${now}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM tail t WHERE t."nodeId"=h."nodeId" AND t.kind=h.kind AND t.device=h.device AND t.direction=h.direction AND t."bucketAt"=h."bucketAt")
    ), devices AS (SELECT DISTINCT device FROM merged ORDER BY device), chosen AS (
      SELECT device FROM devices WHERE ${device ?? null}::text IS NULL OR device=${device ?? null}::text ORDER BY device LIMIT 1
    ), points AS (
      SELECT m.device,m.direction,date_bin(${bucketSeconds}::integer*interval '1 second',m."bucketAt",${since}::timestamptz) AS "recordedAt",
        CASE WHEN sum("gapCount")>0 THEN NULL ELSE sum(numerator)/nullif(sum(denominator),0) END AS value
      FROM merged m JOIN chosen c USING(device) GROUP BY m.device,m.direction,3
    ) SELECT (SELECT coalesce(jsonb_agg(device ORDER BY device),'[]'::jsonb) FROM devices) AS devices,
      (SELECT device FROM chosen) AS device,
      (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.direction,p."recordedAt"),'[]'::jsonb) FROM points p) AS points`,
  };
}
