CREATE TABLE "MetricDeviceHourly" (
    "nodeId" TEXT NOT NULL REFERENCES "Node"("id") ON DELETE CASCADE,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('disk','network','io')),
    "device" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "bucketAt" TIMESTAMPTZ(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL CHECK ("sampleCount" > 0),
    "gapCount" INTEGER NOT NULL CHECK ("gapCount" >= 0 AND "gapCount" <= "sampleCount"),
    "numerator" DOUBLE PRECISION NOT NULL,
    "denominator" DOUBLE PRECISION NOT NULL CHECK ("denominator" >= 0),
    PRIMARY KEY ("nodeId","kind","device","direction","bucketAt")
);
CREATE INDEX "MetricDeviceHourly_bucketAt_idx" ON "MetricDeviceHourly" USING BRIN ("bucketAt");
ALTER TABLE "MetricMaintenanceState" ADD COLUMN "deviceAggregatedThrough" TIMESTAMPTZ(3);

-- Shared by maintenance and the query's not-yet-maintained raw tail. A rate is
-- weighted by observed duration. Missing device identity cannot prove continuity.
CREATE FUNCTION pipkerops_device_hours(from_at TIMESTAMPTZ, until_at TIMESTAMPTZ, node_filter TEXT DEFAULT NULL, kind_filter TEXT DEFAULT NULL)
RETURNS TABLE ("nodeId" TEXT, kind TEXT, device TEXT, direction TEXT, "bucketAt" TIMESTAMPTZ, "sampleCount" INTEGER, "gapCount" INTEGER, numerator DOUBLE PRECISION, denominator DOUBLE PRECISION)
LANGUAGE sql STABLE SET TimeZone = 'UTC'
AS $$
WITH samples AS MATERIALIZED (
    SELECT "nodeId","recordedAt",payload FROM "MetricSample"
    WHERE "recordedAt">=from_at-interval '120 seconds' AND "recordedAt"<until_at
      AND (node_filter IS NULL OR "nodeId"=node_filter)
), extracted AS (
    SELECT "nodeId","recordedAt",'disk' AS kind,item->>'mountpoint' AS device,'使用率' AS direction,item->>'usedPercent' AS raw_value,NULL::text AS identity
    FROM samples CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'disk')='array' THEN payload->'disk' ELSE '[]'::jsonb END) item
    WHERE kind_filter IS NULL OR kind_filter='disk'
    UNION ALL
    SELECT "nodeId","recordedAt",'network',item->>'name',d.label,item->>d.key,payload->'deviceIdentity'->'network'->>(item->>'name')
    FROM samples CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'network')='array' THEN payload->'network' ELSE '[]'::jsonb END) item
    CROSS JOIN (VALUES ('bytesRecv','接收'),('bytesSent','发送')) d(key,label)
    WHERE kind_filter IS NULL OR kind_filter='network'
    UNION ALL
    SELECT "nodeId","recordedAt",'io',item.key,d.label,item.value->>d.key,payload->'deviceIdentity'->'io'->>item.key
    FROM samples CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(payload->'io')='object' THEN payload->'io' ELSE '{}'::jsonb END) item
    CROSS JOIN (VALUES ('readBytes','读取'),('writeBytes','写入')) d(key,label)
    WHERE kind_filter IS NULL OR kind_filter='io'
), parsed AS (
    SELECT *, CASE WHEN length(raw_value)<=40 AND raw_value ~ '^[0-9]+([.][0-9]+)?$' THEN raw_value::double precision END AS value
    FROM extracted WHERE length(device) BETWEEN 1 AND 200
), deltas AS (
    SELECT *,lag(value) OVER w AS previous,lag(identity) OVER w AS previous_identity,
        extract(epoch FROM "recordedAt"-lag("recordedAt") OVER w)::double precision AS elapsed
    FROM parsed WINDOW w AS (PARTITION BY "nodeId",kind,device,direction ORDER BY "recordedAt")
), contributions AS (
    SELECT *, CASE WHEN kind='disk' THEN value BETWEEN 0 AND 100
        ELSE identity IS NOT NULL AND identity=previous_identity AND value>=previous AND elapsed>0 AND elapsed<=120 END AS valid
    FROM deltas WHERE "recordedAt">=from_at
)
SELECT "nodeId",kind,device,direction,date_trunc('hour',"recordedAt"),count(*)::integer,
    count(*) FILTER (WHERE valid IS NOT TRUE)::integer,
    coalesce(sum(CASE WHEN valid THEN CASE WHEN kind='disk' THEN value ELSE value-previous END END),0)::double precision,
    coalesce(sum(CASE WHEN valid THEN CASE WHEN kind='disk' THEN 1 ELSE elapsed END END),0)::double precision
FROM contributions GROUP BY "nodeId",kind,device,direction,5
$$;

CREATE OR REPLACE FUNCTION pipkerops_maintain_metrics(retain_raw_days INTEGER DEFAULT 30, retain_hourly_days INTEGER DEFAULT 365)
RETURNS JSONB
LANGUAGE plpgsql
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
AS $$
DECLARE
    maintenance_state "MetricMaintenanceState"%ROWTYPE;
    completed_hour TIMESTAMPTZ;
    raw_cutoff TIMESTAMPTZ;
    hourly_cutoff TIMESTAMPTZ;
    aggregate_from TIMESTAMPTZ;
    device_from TIMESTAMPTZ;
    device_aggregated BIGINT;
    removed_devices BIGINT;
    partition_start TIMESTAMPTZ;
    partition_end TIMESTAMPTZ;
    partition_name TEXT;
    month_offset INTEGER;
    affected BIGINT;
    aggregated BIGINT;
    removed_raw BIGINT;
    removed_hourly BIGINT;
    has_default_rows BOOLEAN;
    blocked_partitions JSONB := '[]'::jsonb;
    result JSONB;
    child RECORD;
BEGIN
    IF retain_raw_days IS NULL OR retain_hourly_days IS NULL
       OR retain_raw_days < 1 OR retain_hourly_days < retain_raw_days THEN
        RAISE EXCEPTION 'Retention requires 1 <= raw days <= hourly days';
    END IF;
    IF NOT pg_try_advisory_xact_lock(1346981963, 1) THEN
        RETURN jsonb_build_object('skipped', true, 'reason', 'maintenance already running');
    END IF;

    INSERT INTO "MetricMaintenanceState" ("id") VALUES ('metrics') ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT maintenance_state FROM "MetricMaintenanceState" WHERE "id" = 'metrics' FOR UPDATE;
    IF maintenance_state."summary"->>'deviceAggregationVersion' = '1'
       AND maintenance_state."lastSucceededAt"::DATE = CURRENT_TIMESTAMP::DATE
       AND maintenance_state."summary"->>'retainRawDays' = retain_raw_days::TEXT
       AND maintenance_state."summary"->>'retainHourlyDays' = retain_hourly_days::TEXT
       AND coalesce(maintenance_state."summary"->'blockedPartitions', '[]'::jsonb) = '[]'::jsonb THEN
        RETURN maintenance_state."summary" || jsonb_build_object(
            'skipped', true, 'reason', 'maintenance already succeeded today',
            'lastSucceededAt', maintenance_state."lastSucceededAt"
        );
    END IF;

    completed_hour := date_trunc('hour', CURRENT_TIMESTAMP);
    raw_cutoff := date_trunc('hour', CURRENT_TIMESTAMP - make_interval(days => retain_raw_days));
    hourly_cutoff := date_trunc('hour', CURRENT_TIMESTAMP - make_interval(days => retain_hourly_days));
    -- A first run or an old watermark covers the outage, including raw rows older
    -- than raw retention. The 48-hour overlap incorporates ordinary late arrivals.
    aggregate_from := greatest(
        hourly_cutoff,
        least(coalesce(maintenance_state."aggregatedThrough", hourly_cutoff), completed_hour) - interval '48 hours',
        -- Never recompute a previously cleaned hour from a sparse late arrival.
        -- This matters when configured raw retention is shorter than the overlap.
        coalesce((maintenance_state."summary"->>'rawCutoff')::TIMESTAMPTZ, hourly_cutoff)
    );
    INSERT INTO "MetricHourly" ("nodeId", "bucketAt", "sampleCount", "cpuAvg", "cpuMax", "memoryAvg", "memoryMax")
    SELECT "nodeId", date_trunc('hour', "recordedAt"),
           count(*)::INTEGER, avg("cpuPercent"), max("cpuPercent"),
           avg("memoryPercent"), max("memoryPercent")
    FROM "MetricSample"
    WHERE "recordedAt" >= aggregate_from AND "recordedAt" < completed_hour
    GROUP BY "nodeId", date_trunc('hour', "recordedAt")
    ON CONFLICT ("nodeId", "bucketAt") DO UPDATE SET
        "sampleCount" = EXCLUDED."sampleCount",
        "cpuAvg" = EXCLUDED."cpuAvg", "cpuMax" = EXCLUDED."cpuMax",
        "memoryAvg" = EXCLUDED."memoryAvg", "memoryMax" = EXCLUDED."memoryMax";
    GET DIAGNOSTICS aggregated = ROW_COUNT;

    device_from := greatest(
        hourly_cutoff,
        least(coalesce(maintenance_state."deviceAggregatedThrough",hourly_cutoff),completed_hour)-interval '48 hours',
        coalesce((maintenance_state."summary"->>'rawCutoff')::TIMESTAMPTZ,hourly_cutoff)
    );
    INSERT INTO "MetricDeviceHourly"
    SELECT * FROM pipkerops_device_hours(device_from,completed_hour)
    ON CONFLICT ("nodeId",kind,device,direction,"bucketAt") DO UPDATE SET
        "sampleCount"=EXCLUDED."sampleCount", "gapCount"=EXCLUDED."gapCount",
        numerator=EXCLUDED.numerator, denominator=EXCLUDED.denominator;
    GET DIAGNOSTICS device_aggregated = ROW_COUNT;

    -- No cleanup occurs until aggregation has succeeded. All operations remain in
    -- the caller's transaction, including DDL and the final durable state update.
    FOR child IN
        SELECT c.relname, n.nspname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent = '"MetricSample"'::regclass
          AND c.relname ~ '^MetricSample_[0-9]{6}$'
    LOOP
        IF (to_date(substring(child.relname FROM 14), 'YYYYMM')::TIMESTAMPTZ) + interval '1 month' <= raw_cutoff THEN
            EXECUTE format('DROP TABLE %I.%I', child.nspname, child.relname);
        END IF;
    END LOOP;
    DELETE FROM "MetricSample" WHERE "recordedAt" < raw_cutoff;
    GET DIAGNOSTICS removed_raw = ROW_COUNT;
    DELETE FROM "MetricHourly" WHERE "bucketAt" < hourly_cutoff;
    GET DIAGNOSTICS removed_hourly = ROW_COUNT;

    DELETE FROM "MetricDeviceHourly" WHERE "bucketAt" < hourly_cutoff;
    GET DIAGNOSTICS removed_devices = ROW_COUNT;

    FOR month_offset IN 0..2 LOOP
        partition_start := date_trunc('month', CURRENT_TIMESTAMP) + make_interval(months => month_offset);
        partition_end := partition_start + interval '1 month';
        partition_name := 'MetricSample_' || to_char(partition_start, 'YYYYMM');
        IF to_regclass(format('%I', partition_name)) IS NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM "MetricSample_default"
                WHERE "recordedAt" >= partition_start AND "recordedAt" < partition_end
            ) INTO has_default_rows;
            IF has_default_rows THEN
                blocked_partitions := blocked_partitions || jsonb_build_array(partition_name);
            ELSE
                BEGIN
                    EXECUTE format(
                        'CREATE TABLE %I PARTITION OF "MetricSample" FOR VALUES FROM (%L) TO (%L)',
                        partition_name, partition_start, partition_end
                    );
                EXCEPTION WHEN check_violation THEN
                    -- A concurrent insert may reach DEFAULT between the check and
                    -- CREATE. Preserve that data and report the blocked partition.
                    blocked_partitions := blocked_partitions || jsonb_build_array(partition_name);
                END;
            END IF;
        END IF;
    END LOOP;

    DELETE FROM "ProbeResult" WHERE "recordedAt" < raw_cutoff;
    GET DIAGNOSTICS affected = ROW_COUNT;
    result := jsonb_build_object(
        'skipped', false, 'aggregatedHours', aggregated,
        'deviceAggregationVersion', 1, 'deviceAggregatedHours',device_aggregated,
        'deviceAggregatedFrom',device_from,'removedDeviceHours',removed_devices,
        'aggregatedFrom', aggregate_from, 'aggregatedThrough', completed_hour,
        'retainRawDays', retain_raw_days, 'retainHourlyDays', retain_hourly_days,
        'rawCutoff', raw_cutoff, 'hourlyCutoff', hourly_cutoff,
        'removedRawRows', removed_raw, 'removedHourlyRows', removed_hourly,
        'removedProbeResults', affected, 'blockedPartitions', blocked_partitions
    );
    UPDATE "MetricMaintenanceState" SET
        "aggregatedThrough" = completed_hour,
        "deviceAggregatedThrough" = completed_hour,
        "lastSucceededAt" = CURRENT_TIMESTAMP,
        "summary" = result
    WHERE "id" = 'metrics';
    RETURN result;
END $$;
