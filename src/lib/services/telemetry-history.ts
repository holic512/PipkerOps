import { db } from "../db";
import { Prisma } from "@/generated/prisma/client";
import { ApiError, authorize, type Actor } from "../auth";
export async function numericHistory(
  actor: Actor,
  nodeId: string,
  metric: string | undefined,
  hours: number,
  device?: string,
) {
  authorize(actor, "nodes:read", nodeId);
  if (!metric) throw new ApiError(400, "数值历史需要 metric");
  const { query, bucketSeconds } = numericHistoryQuery(nodeId, metric, hours);
  const rows =
    await db().$queryRaw<
      { device: string; unit: string; recordedAt: Date; value: number | null }[]
    >(query);
  const devices = [...new Set(rows.map((r) => r.device))].sort();
  const chosen = device ?? devices[0] ?? null;
  return {
    metric,
    unit: rows[0]?.unit ?? "",
    bucketSeconds,
    devices,
    device: chosen,
    series: [
      {
        name: metric,
        points: rows
          .filter((r) => r.device === chosen)
          .map((r) => ({ recordedAt: r.recordedAt, value: r.value })),
      },
    ],
  };
}

export function numericHistoryQuery(
  nodeId: string,
  metric: string,
  hours: number,
  now = new Date(),
) {
  if (!Number.isFinite(hours) || hours < 1 || hours > 8760)
    throw new ApiError(400, "查询时间范围无效");
  const since = new Date(now.getTime() - hours * 3600000);
  const bucketSeconds = Math.max(15, Math.ceil((hours * 3600) / 720));
  return {
    bucketSeconds,
    query: Prisma.sql`
    WITH raw AS (
      SELECT s."recordedAt",coalesce(p->>'device','') AS device,p->>'unit' AS unit,(p->>'value')::double precision AS value
      FROM "TelemetrySample" s CROSS JOIN LATERAL jsonb_array_elements(series) p
      WHERE s."nodeId"=${nodeId} AND s."recordedAt">=${since} AND s."recordedAt"<${now} AND p->>'metric'=${metric}
    ), hours AS (
      SELECT date_trunc('hour',"recordedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "recordedAt",device,unit,
       CASE WHEN count(*) FILTER(WHERE value IS NULL)>0 THEN NULL ELSE avg(value) END AS value FROM raw GROUP BY 1,2,3
    ), merged AS (
      SELECT * FROM raw WHERE ${hours}<=48
      UNION ALL SELECT * FROM hours WHERE ${hours}>48
      UNION ALL SELECT h."bucketAt",h.device,h.unit,CASE WHEN h."gapCount">0 THEN NULL ELSE h.mean END
      FROM "TelemetryHourly" h WHERE ${hours}>48 AND h."nodeId"=${nodeId} AND h.metric=${metric} AND h."bucketAt">=${since} AND h."bucketAt"<${now}
      AND NOT EXISTS (SELECT 1 FROM hours r WHERE r."recordedAt"=h."bucketAt" AND r.device=h.device)
    ) SELECT device,unit,date_bin(${bucketSeconds}::integer*interval '1 second',"recordedAt",${since}) AS "recordedAt",
      CASE WHEN count(*) FILTER(WHERE value IS NULL)>0 THEN NULL ELSE avg(value) END AS value
      FROM merged GROUP BY 1,2,3 ORDER BY 3`,
  };
}
