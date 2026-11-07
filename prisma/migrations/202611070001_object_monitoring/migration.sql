-- Additive stores; resource history and task/log protocols are unchanged.
CREATE TABLE "ProcessWatchConfig" (
  "nodeId" text PRIMARY KEY REFERENCES "Node"(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  "ackRevision" integer NOT NULL DEFAULT -1,
  "ackedAt" timestamptz(3)
);
CREATE TABLE "ProcessWatch" (
  "nodeId" text NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
  "objectId" text NOT NULL,
  "bootId" text NOT NULL,
  pid integer NOT NULL CHECK (pid > 0),
  "startTicks" text NOT NULL CHECK ("startTicks" ~ '^[0-9]+$'),
  name text NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("nodeId", "objectId")
);
CREATE TABLE "MonitoringSample" (
  "nodeId" text NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
  kind text NOT NULL,
  "objectId" text NOT NULL,
  "recordedAt" timestamptz(3) NOT NULL,
  "bootId" text NOT NULL,
  identity jsonb NOT NULL,
  state text NOT NULL,
  coverage text NOT NULL,
  reason text NOT NULL,
  metrics jsonb NOT NULL,
  PRIMARY KEY ("nodeId", kind, "objectId", "recordedAt")
) PARTITION BY RANGE ("recordedAt");
CREATE TABLE "MonitoringSample_default" PARTITION OF "MonitoringSample" DEFAULT;
CREATE INDEX ON "MonitoringSample" ("nodeId", kind, "objectId", "recordedAt" DESC);
CREATE INDEX ON "MonitoringSample" USING brin ("recordedAt");
CREATE TABLE "MonitoringAggregate" (
  "nodeId" text NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
  kind text NOT NULL, "objectId" text NOT NULL, "bucketAt" timestamptz(3) NOT NULL,
  "bootId" text NOT NULL, identity jsonb NOT NULL, metrics jsonb NOT NULL,
  "sampleCount" integer NOT NULL, "gapCount" integer NOT NULL,
  PRIMARY KEY ("nodeId", kind, "objectId", "bucketAt", "bootId")
) PARTITION BY RANGE ("bucketAt");
CREATE TABLE "MonitoringAggregate_default" PARTITION OF "MonitoringAggregate" DEFAULT;
CREATE INDEX ON "MonitoringAggregate" ("nodeId", kind, "objectId", "bucketAt" DESC);
CREATE TABLE "MonitoringEvent" (
  id text NOT NULL, "nodeId" text NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
  kind text NOT NULL, "objectId" text NOT NULL, "recordedAt" timestamptz(3) NOT NULL,
  "bootId" text NOT NULL, identity jsonb NOT NULL, "fromState" text,
  "toState" text NOT NULL, coverage text NOT NULL, reason text NOT NULL,
  PRIMARY KEY (id, "recordedAt")
) PARTITION BY RANGE ("recordedAt");
CREATE TABLE "MonitoringEvent_default" PARTITION OF "MonitoringEvent" DEFAULT;
CREATE INDEX ON "MonitoringEvent" ("nodeId", kind, "objectId", "recordedAt" DESC, id DESC);
CREATE TABLE "MonitoringState" (
  "nodeId" text NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
  kind text NOT NULL, "objectId" text NOT NULL, "recordedAt" timestamptz(3) NOT NULL,
  "bootId" text NOT NULL, identity jsonb NOT NULL, state text NOT NULL, coverage text NOT NULL,
  PRIMARY KEY ("nodeId", kind, "objectId")
);
CREATE TABLE "MonitoringIngestCursor" (
  "nodeId" text NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
  category text NOT NULL, "recordedAt" timestamptz(3) NOT NULL,
  "bootId" text NOT NULL, sequence bigint NOT NULL,
  PRIMARY KEY ("nodeId", category)
);
CREATE TABLE "MonitoringDirtyBucket" ("bucketAt" timestamptz(3) PRIMARY KEY);
CREATE TABLE "MonitoringMaintenance" (id integer PRIMARY KEY, through timestamptz(3));
INSERT INTO "MonitoringMaintenance" VALUES (1, NULL);

-- UTC partitions, including a default for late frames. Move default rows while
-- holding the parent lock before attaching a new daily partition.
CREATE FUNCTION pipkerops_monitoring_partitions(p_now timestamptz DEFAULT now()) RETURNS void LANGUAGE plpgsql AS $$
DECLARE parent text; stamp text; child text; col text; day_start timestamptz; day_end timestamptz; offset_day integer;
BEGIN
  FOR parent IN SELECT unnest(ARRAY['MonitoringSample','MonitoringAggregate','MonitoringEvent']) LOOP
    col := CASE WHEN parent='MonitoringAggregate' THEN 'bucketAt' ELSE 'recordedAt' END;
    FOR offset_day IN -1..2 LOOP
      day_start := ((p_now AT TIME ZONE 'UTC')::date + offset_day)::timestamp AT TIME ZONE 'UTC';
      day_end := day_start + interval '1 day';
      stamp := to_char(day_start AT TIME ZONE 'UTC','YYYYMMDD'); child := parent || '_' || stamp;
      IF to_regclass(format('%I',child)) IS NULL THEN
        EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE',parent);
        EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',child,parent);
        EXECUTE format('WITH moved AS (DELETE FROM %I WHERE %I >= $1 AND %I < $2 RETURNING *) INSERT INTO %I SELECT * FROM moved',parent||'_default',col,col,child) USING day_start,day_end;
        EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',parent,child,day_start,day_end);
      END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION pipkerops_maintain_object_history(p_now timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE cutoff timestamptz := date_bin(interval '5 minutes',p_now,'2000-01-01 UTC'); dirty timestamptz; part record; bound_date date; removed integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('pipkerops-object-maintenance')) THEN RETURN '{"skipped":true}'::jsonb; END IF;
  PERFORM pipkerops_monitoring_partitions(p_now);
  -- Ingest marks buckets dirty in the same transaction as samples. Deleting the
  -- marker locks it; a concurrent writer must reinsert it after this transaction.
  FOR dirty IN DELETE FROM "MonitoringDirtyBucket" WHERE "bucketAt"<cutoff RETURNING "bucketAt" LOOP
    DELETE FROM "MonitoringAggregate" WHERE "bucketAt"=dirty;
    INSERT INTO "MonitoringAggregate" ("nodeId",kind,"objectId","bucketAt","bootId",identity,metrics,"sampleCount","gapCount")
    WITH expanded AS (
      SELECT s.*,m.key AS metric,m.value AS point FROM "MonitoringSample" s
      CROSS JOIN LATERAL jsonb_each(s.metrics) m
      WHERE s."recordedAt">=dirty AND s."recordedAt"<dirty+interval '5 minutes'
    ), grouped AS (
      SELECT "nodeId",kind,"objectId","bootId",metric,
        (array_agg(identity ORDER BY "recordedAt" DESC))[1] AS identity,
        jsonb_build_object('unit',max(point->>'unit'),'validCount',count(*) FILTER(WHERE point->>'value' IS NOT NULL),
          'gapCount',count(*) FILTER(WHERE point->>'value' IS NULL OR coverage<>'covered'),
          'weightMs',coalesce(sum((point->>'weightMs')::double precision) FILTER(WHERE point->>'value' IS NOT NULL),0),
          'mean',sum((point->>'value')::double precision*(point->>'weightMs')::double precision)/nullif(sum((point->>'weightMs')::double precision) FILTER(WHERE point->>'value' IS NOT NULL),0),
          'maximum',max((point->>'value')::double precision)) AS point,
        count(*)::integer AS n,count(*) FILTER(WHERE coverage<>'covered')::integer AS gaps
      FROM expanded GROUP BY 1,2,3,4,5
    ) SELECT "nodeId",kind,"objectId",dirty,"bootId",(array_agg(identity))[1],jsonb_object_agg(metric,point),max(n),max(gaps)
      FROM grouped GROUP BY 1,2,3,5;
  END LOOP;
  UPDATE "MonitoringMaintenance" SET through=cutoff WHERE id=1;
  -- Aggregate and cleanup commit atomically. Never expire an unaggregated bucket.
  DELETE FROM "MonitoringSample" s WHERE s."recordedAt"<p_now-interval '7 days'
    AND NOT EXISTS(SELECT 1 FROM "MonitoringDirtyBucket" d WHERE d."bucketAt"=date_bin(interval '5 minutes',s."recordedAt",'2000-01-01 UTC'));
  DELETE FROM "MonitoringAggregate" WHERE "bucketAt"<p_now-interval '30 days';
  DELETE FROM "MonitoringEvent" WHERE "recordedAt"<p_now-interval '30 days';
  DELETE FROM "MonitoringState" WHERE "recordedAt"<p_now-interval '30 days';
  FOR part IN SELECT c.relname,p.relname AS parent FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname IN ('MonitoringSample','MonitoringAggregate','MonitoringEvent') LOOP
    IF part.relname ~ '_[0-9]{8}$' THEN
      bound_date := to_date(right(part.relname,8),'YYYYMMDD');
      IF (bound_date+1)::timestamp AT TIME ZONE 'UTC' <= p_now - (CASE WHEN part.parent='MonitoringSample' THEN interval '7 days' ELSE interval '30 days' END) THEN
        EXECUTE format('DROP TABLE %I',part.relname); removed := removed+1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('through',cutoff,'removedPartitions',removed);
END $$;
SELECT pipkerops_monitoring_partitions();
