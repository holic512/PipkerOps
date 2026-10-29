-- PipkerOps initial schema. Apply through Prisma Migrate to an empty database.
-- MetricSample is partitioned; raw SQL constraints and partition maintenance are intentional.

CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE "NodeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');
CREATE TYPE "ProbeType" AS ENUM ('HTTP', 'TCP');
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN');
CREATE TYPE "TaskSource" AS ENUM ('WEB', 'MCP', 'CRON', 'SYSTEM');

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "nodeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowDangerous" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnrollmentToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnrollmentToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "status" "NodeStatus" NOT NULL DEFAULT 'PENDING',
    "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "os" TEXT,
    "arch" TEXT,
    "agentVersion" TEXT,
    "ipAddress" TEXT,
    "certificateSerial" TEXT,
    "certificateFingerprint" TEXT,
    "csrPem" TEXT,
    "certificatePem" TEXT,
    "enrollmentTokenId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryPercent" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id", "recordedAt")
) PARTITION BY RANGE ("recordedAt");

CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "businessData" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "healthUrl" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Dependency" (
    "id" TEXT NOT NULL,
    "fromApplicationId" TEXT NOT NULL,
    "toApplicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'depends_on',
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Dependency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Probe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProbeType" NOT NULL,
    "applicationId" TEXT,
    "sourceNodeId" TEXT,
    "target" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "mapping" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "nextRunAt" TIMESTAMPTZ(3),
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Probe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProbeResult" (
    "id" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "sourceNodeId" TEXT,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "latencyMs" DOUBLE PRECISION NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "ProbeResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "nodeId" TEXT,
    "actorId" TEXT,
    "apiKeyId" TEXT,
    "source" "TaskSource" NOT NULL DEFAULT 'WEB',
    "idempotencyKey" TEXT,
    "idempotent" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "dispatchedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "output" TEXT,
    "result" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'stdout',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "apiKeyId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "nodeId" TEXT,
    "ipAddress" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "taskType" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "nodeId" TEXT,
    "createdById" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMPTZ(3),
    "lastRunAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodeId" TEXT,
    "probeId" TEXT,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'gt',
    "threshold" DOUBLE PRECISION NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "alertRuleId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "httpsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "certificateExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomAction" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "parameters" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "nodeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "dangerous" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "CustomAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetricHourly" (
    "nodeId" TEXT NOT NULL,
    "bucketAt" TIMESTAMPTZ(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "cpuAvg" DOUBLE PRECISION NOT NULL,
    "cpuMax" DOUBLE PRECISION NOT NULL,
    "memoryAvg" DOUBLE PRECISION NOT NULL,
    "memoryMax" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "MetricHourly_pkey" PRIMARY KEY ("nodeId", "bucketAt")
);

-- Create the current and next two calendar months before ingestion starts.
DO $$
DECLARE
    partition_start TIMESTAMPTZ;
    month_offset INTEGER;
BEGIN
    PERFORM set_config('TimeZone', 'UTC', true);
    FOR month_offset IN 0..2 LOOP
        partition_start := date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                           + make_interval(months => month_offset);
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF "MetricSample" FOR VALUES FROM (%L) TO (%L)',
            'MetricSample_' || to_char(partition_start AT TIME ZONE 'UTC', 'YYYYMM'),
            partition_start,
            partition_start + interval '1 month'
        );
    END LOOP;
END $$;

-- Default partition safely receives out-of-range/late samples.
CREATE TABLE "MetricSample_default" PARTITION OF "MetricSample" DEFAULT;

CREATE UNIQUE INDEX "User_email_key" ON "User" ("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session" ("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session" ("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey" ("keyHash");
CREATE INDEX "ApiKey_userId_revokedAt_idx" ON "ApiKey" ("userId", "revokedAt");
CREATE UNIQUE INDEX "EnrollmentToken_tokenHash_key" ON "EnrollmentToken" ("tokenHash");
CREATE INDEX "EnrollmentToken_expiresAt_idx" ON "EnrollmentToken" ("expiresAt");
CREATE UNIQUE INDEX "Node_certificateSerial_key" ON "Node" ("certificateSerial");
CREATE UNIQUE INDEX "Node_certificateFingerprint_key" ON "Node" ("certificateFingerprint");
CREATE INDEX "Node_status_lastSeenAt_idx" ON "Node" ("status", "lastSeenAt");
CREATE INDEX "Node_enrollmentTokenId_idx" ON "Node" ("enrollmentTokenId");
CREATE INDEX "MetricSample_nodeId_recordedAt_idx" ON "MetricSample" ("nodeId", "recordedAt" DESC);
CREATE INDEX "MetricSample_recordedAt_idx" ON "MetricSample" USING BRIN ("recordedAt");
CREATE UNIQUE INDEX "Application_name_key" ON "Application" ("name");
CREATE INDEX "Deployment_applicationId_idx" ON "Deployment" ("applicationId");
CREATE INDEX "Deployment_nodeId_type_idx" ON "Deployment" ("nodeId", "type");
CREATE UNIQUE INDEX "Deployment_applicationId_nodeId_type_target_key" ON "Deployment" ("applicationId", "nodeId", "type", "target");
CREATE UNIQUE INDEX "Dependency_fromApplicationId_toApplicationId_type_key" ON "Dependency" ("fromApplicationId", "toApplicationId", "type");
CREATE INDEX "Dependency_toApplicationId_idx" ON "Dependency" ("toApplicationId");
CREATE INDEX "Probe_enabled_nextRunAt_idx" ON "Probe" ("enabled", "nextRunAt");
CREATE INDEX "Probe_applicationId_idx" ON "Probe" ("applicationId");
CREATE INDEX "Probe_sourceNodeId_idx" ON "Probe" ("sourceNodeId");
CREATE INDEX "ProbeResult_probeId_recordedAt_idx" ON "ProbeResult" ("probeId", "recordedAt" DESC);
CREATE INDEX "ProbeResult_recordedAt_idx" ON "ProbeResult" USING BRIN ("recordedAt");
CREATE UNIQUE INDEX "Task_idempotencyKey_key" ON "Task" ("idempotencyKey");
CREATE INDEX "Task_status_createdAt_idx" ON "Task" ("status", "createdAt");
CREATE INDEX "Task_nodeId_status_createdAt_idx" ON "Task" ("nodeId", "status", "createdAt");
CREATE INDEX "Task_status_leaseExpiresAt_idx" ON "Task" ("status", "leaseExpiresAt");
CREATE INDEX "Task_actorId_createdAt_idx" ON "Task" ("actorId", "createdAt" DESC);
CREATE UNIQUE INDEX "TaskLog_taskId_sequence_key" ON "TaskLog" ("taskId", "sequence");
CREATE INDEX "TaskLog_createdAt_idx" ON "TaskLog" USING BRIN ("createdAt");
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent" ("createdAt" DESC);
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent" ("actorId", "createdAt" DESC);
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent" ("resourceType", "resourceId");
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule" ("enabled", "nextRunAt");
CREATE INDEX "AlertRule_nodeId_enabled_idx" ON "AlertRule" ("nodeId", "enabled");
CREATE INDEX "AlertRule_probeId_enabled_idx" ON "AlertRule" ("probeId", "enabled");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification" ("userId", "readAt", "createdAt" DESC);
CREATE INDEX "Notification_alertRuleId_createdAt_idx" ON "Notification" ("alertRuleId", "createdAt" DESC);
CREATE UNIQUE INDEX "Site_domain_key" ON "Site" ("domain");
CREATE INDEX "Site_nodeId_status_idx" ON "Site" ("nodeId", "status");
CREATE INDEX "CustomAction_type_idx" ON "CustomAction" ("type");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnrollmentToken" ADD CONSTRAINT "EnrollmentToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Node" ADD CONSTRAINT "Node_enrollmentTokenId_fkey" FOREIGN KEY ("enrollmentTokenId") REFERENCES "EnrollmentToken" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Node" ADD CONSTRAINT "Node_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_fromApplicationId_fkey" FOREIGN KEY ("fromApplicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_toApplicationId_fkey" FOREIGN KEY ("toApplicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Probe" ADD CONSTRAINT "Probe_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Probe" ADD CONSTRAINT "Probe_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "Node" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProbeResult" ADD CONSTRAINT "ProbeResult_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "Probe" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProbeResult" ADD CONSTRAINT "ProbeResult_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "Node" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskLog" ADD CONSTRAINT "TaskLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "Probe" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_alertRuleId_fkey" FOREIGN KEY ("alertRuleId") REFERENCES "AlertRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Site" ADD CONSTRAINT "Site_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomAction" ADD CONSTRAINT "CustomAction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Business invariants not expressible in Prisma schema.
ALTER TABLE "EnrollmentToken" ADD CONSTRAINT "EnrollmentToken_usage_check" CHECK ("maxUses" > 0 AND "usedCount" >= 0 AND "usedCount" <= "maxUses");
ALTER TABLE "Probe" ADD CONSTRAINT "Probe_timing_check" CHECK ("intervalSeconds" >= 5 AND "timeoutMs" >= 100 AND "timeoutMs" <= 120000 AND "failureThreshold" > 0 AND "failureCount" >= 0);
ALTER TABLE "Task" ADD CONSTRAINT "Task_retry_check" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1 AND ("idempotent" OR "maxAttempts" = 1));
ALTER TABLE "TaskLog" ADD CONSTRAINT "TaskLog_sequence_check" CHECK ("sequence" >= 0);
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_no_self_reference" CHECK ("fromApplicationId" <> "toApplicationId");
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_target_check" CHECK (num_nonnulls("nodeId", "probeId") = 1);
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_duration_check" CHECK ("durationSeconds" >= 0);

CREATE INDEX "MetricHourly_bucketAt_idx" ON "MetricHourly" USING BRIN ("bucketAt");
ALTER TABLE "MetricHourly" ADD CONSTRAINT "MetricHourly_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MetricHourly" ADD CONSTRAINT "MetricHourly_count_check" CHECK ("sampleCount" > 0);

-- Call daily from the Worker, outside request processing. A transaction-scoped advisory
-- lock makes concurrent Worker calls safe. UTC buckets are independent of session TZ.
CREATE FUNCTION pipkerops_maintain_metrics(retain_raw_days INTEGER DEFAULT 30, retain_hourly_days INTEGER DEFAULT 365)
RETURNS JSONB
LANGUAGE plpgsql
SET TimeZone = 'UTC'
AS $$
DECLARE
    cutoff TIMESTAMPTZ;
    partition_start TIMESTAMPTZ;
    partition_end TIMESTAMPTZ;
    partition_name TEXT;
    month_offset INTEGER;
    affected BIGINT;
    aggregated BIGINT;
    removed_raw BIGINT;
    removed_hourly BIGINT;
    has_default_rows BOOLEAN;
    child RECORD;
BEGIN
    IF retain_raw_days < 1 OR retain_hourly_days < retain_raw_days THEN
        RAISE EXCEPTION 'Retention requires 1 <= raw days <= hourly days';
    END IF;
    IF NOT pg_try_advisory_xact_lock(1346981963, 1) THEN
        RETURN jsonb_build_object('skipped', true, 'reason', 'maintenance already running');
    END IF;

    -- Retention aligns to a complete UTC hour, keeping hourly aggregates stable after
    -- deletion (otherwise the boundary hour could be overwritten with partial data).
    cutoff := date_trunc('hour', CURRENT_TIMESTAMP - make_interval(days => retain_raw_days));

    -- Recompute retained, completed hours so late arrivals are reflected. The bounded
    -- raw window is intentional for a 10-50 node installation; tune the call cadence.
    INSERT INTO "MetricHourly" ("nodeId", "bucketAt", "sampleCount", "cpuAvg", "cpuMax", "memoryAvg", "memoryMax")
    SELECT "nodeId",
           date_trunc('hour', "recordedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
           count(*)::INTEGER, avg("cpuPercent"), max("cpuPercent"),
           avg("memoryPercent"), max("memoryPercent")
    FROM "MetricSample"
    WHERE "recordedAt" >= cutoff
      AND "recordedAt" < date_trunc('hour', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    GROUP BY "nodeId", date_trunc('hour', "recordedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ON CONFLICT ("nodeId", "bucketAt") DO UPDATE SET
        "sampleCount" = EXCLUDED."sampleCount",
        "cpuAvg" = EXCLUDED."cpuAvg", "cpuMax" = EXCLUDED."cpuMax",
        "memoryAvg" = EXCLUDED."memoryAvg", "memoryMax" = EXCLUDED."memoryMax";
    GET DIAGNOSTICS aggregated = ROW_COUNT;

    -- Only drop fully expired partitions. The partial boundary month is deleted below.
    FOR child IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = '"MetricSample"'::regclass
          AND c.relname ~ '^MetricSample_[0-9]{6}$'
    LOOP
        IF (to_date(substring(child.relname FROM 14), 'YYYYMM')::TIMESTAMP AT TIME ZONE 'UTC') + interval '1 month' <= cutoff THEN
            EXECUTE format('DROP TABLE %I', child.relname);
        END IF;
    END LOOP;
    DELETE FROM "MetricSample" WHERE "recordedAt" < cutoff;
    GET DIAGNOSTICS removed_raw = ROW_COUNT;
    DELETE FROM "MetricHourly" WHERE "bucketAt" < CURRENT_TIMESTAMP - make_interval(days => retain_hourly_days);
    GET DIAGNOSTICS removed_hourly = ROW_COUNT;

    FOR month_offset IN 0..2 LOOP
        partition_start := date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                           + make_interval(months => month_offset);
        partition_end := partition_start + interval '1 month';
        partition_name := 'MetricSample_' || to_char(partition_start AT TIME ZONE 'UTC', 'YYYYMM');
        IF to_regclass(format('%I', partition_name)) IS NULL THEN
            -- A future-dated sample in the default partition cannot be silently moved
            -- under concurrent ingestion. Leave it there and report through monitoring.
            SELECT EXISTS (
                SELECT 1 FROM "MetricSample_default"
                WHERE "recordedAt" >= partition_start AND "recordedAt" < partition_end
            ) INTO has_default_rows;
            IF NOT has_default_rows THEN
                EXECUTE format(
                    'CREATE TABLE %I PARTITION OF "MetricSample" FOR VALUES FROM (%L) TO (%L)',
                    partition_name, partition_start, partition_end
                );
            END IF;
        END IF;
    END LOOP;

    -- Probe detail is bounded alongside raw metrics. Audit events and task logs remain
    -- untouched; deployments choose an explicit audit retention/export policy.
    DELETE FROM "ProbeResult" WHERE "recordedAt" < cutoff;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN jsonb_build_object(
        'skipped', false, 'aggregatedHours', aggregated,
        'removedRawRows', removed_raw, 'removedHourlyRows', removed_hourly,
        'removedProbeResults', affected
    );
END $$;
