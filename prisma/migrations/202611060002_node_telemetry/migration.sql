ALTER TABLE "MetricSample" ALTER COLUMN "cpuPercent" DROP NOT NULL, ALTER COLUMN "memoryPercent" DROP NOT NULL;
ALTER TABLE "MetricHourly" ALTER COLUMN "cpuAvg" DROP NOT NULL, ALTER COLUMN "cpuMax" DROP NOT NULL, ALTER COLUMN "memoryAvg" DROP NOT NULL, ALTER COLUMN "memoryMax" DROP NOT NULL;

CREATE TABLE "NodeTelemetry" (
 "nodeId" TEXT NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
 category TEXT NOT NULL CHECK (category IN ('fast','disks','details','static','legacy')),
 snapshot JSONB NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL,
 PRIMARY KEY ("nodeId", category)
);
CREATE TABLE "TelemetrySample" (
 "nodeId" TEXT NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
 "recordedAt" TIMESTAMPTZ(3) NOT NULL,
 series JSONB NOT NULL CHECK (jsonb_typeof(series)='array'),
 PRIMARY KEY ("nodeId","recordedAt")
);
CREATE INDEX "TelemetrySample_recordedAt_idx" ON "TelemetrySample" USING BRIN ("recordedAt");
CREATE TABLE "TelemetryHourly" (
 "nodeId" TEXT NOT NULL REFERENCES "Node"(id) ON DELETE CASCADE,
 metric TEXT NOT NULL, device TEXT NOT NULL, unit TEXT NOT NULL,
 "bucketAt" TIMESTAMPTZ(3) NOT NULL,
 "sampleCount" INTEGER NOT NULL, "gapCount" INTEGER NOT NULL,
 mean DOUBLE PRECISION, maximum DOUBLE PRECISION,
 PRIMARY KEY ("nodeId",metric,device,"bucketAt")
);
CREATE INDEX "TelemetryHourly_bucketAt_idx" ON "TelemetryHourly" USING BRIN ("bucketAt");
CREATE TABLE "TelemetryMaintenance" (id INTEGER PRIMARY KEY CHECK (id=1), through TIMESTAMPTZ(3));
INSERT INTO "TelemetryMaintenance" VALUES (1,NULL);
CREATE FUNCTION pipkerops_maintain_telemetry() RETURNS VOID LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE start_at TIMESTAMPTZ; end_at TIMESTAMPTZ := date_trunc('hour',now());
BEGIN
 IF NOT pg_try_advisory_xact_lock(73490126) THEN RETURN; END IF;
 SELECT coalesce(through-interval '48 hours',(SELECT min("recordedAt") FROM "TelemetrySample")) INTO start_at FROM "TelemetryMaintenance" WHERE id=1 FOR UPDATE;
 INSERT INTO "TelemetryHourly"
 SELECT s."nodeId",p->>'metric',coalesce(p->>'device',''),p->>'unit',date_trunc('hour',s."recordedAt"),count(*)::integer,
 count(*) FILTER (WHERE p->>'value' IS NULL)::integer,avg((p->>'value')::double precision),max((p->>'value')::double precision)
 FROM "TelemetrySample" s CROSS JOIN LATERAL jsonb_array_elements(series) p
 WHERE s."recordedAt">=start_at AND s."recordedAt"<end_at
 GROUP BY 1,2,3,4,5
 ON CONFLICT ("nodeId",metric,device,"bucketAt") DO UPDATE SET "sampleCount"=EXCLUDED."sampleCount","gapCount"=EXCLUDED."gapCount",mean=EXCLUDED.mean,maximum=EXCLUDED.maximum;
 DELETE FROM "TelemetrySample" WHERE "recordedAt"<now()-interval '30 days';
 DELETE FROM "TelemetryHourly" WHERE "bucketAt"<now()-interval '365 days';
 UPDATE "TelemetryMaintenance" SET through=end_at WHERE id=1;
END $$;
