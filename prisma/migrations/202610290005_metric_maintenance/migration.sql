-- Durable aggregation progress. A completed hour is an exclusive watermark;
-- raw cleanup and watermark advancement commit together with its aggregates.
CREATE TABLE "MetricMaintenanceState" (
    "id" TEXT NOT NULL DEFAULT 'metrics',
    "aggregatedThrough" TIMESTAMPTZ(3),
    "lastSucceededAt" TIMESTAMPTZ(3),
    "summary" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "MetricMaintenanceState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MetricMaintenanceState_singleton_check" CHECK ("id" = 'metrics')
);

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
    IF maintenance_state."lastSucceededAt"::DATE = CURRENT_TIMESTAMP::DATE
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
        'aggregatedFrom', aggregate_from, 'aggregatedThrough', completed_hour,
        'retainRawDays', retain_raw_days, 'retainHourlyDays', retain_hourly_days,
        'rawCutoff', raw_cutoff, 'hourlyCutoff', hourly_cutoff,
        'removedRawRows', removed_raw, 'removedHourlyRows', removed_hourly,
        'removedProbeResults', affected, 'blockedPartitions', blocked_partitions
    );
    UPDATE "MetricMaintenanceState" SET
        "aggregatedThrough" = completed_hour,
        "lastSucceededAt" = CURRENT_TIMESTAMP,
        "summary" = result
    WHERE "id" = 'metrics';
    RETURN result;
END $$;
