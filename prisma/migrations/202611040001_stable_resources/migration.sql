CREATE TABLE "Resource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "nodeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "strategy" TEXT NOT NULL,
  "locatorKey" TEXT,
  "project" TEXT,
  "service" TEXT,
  "containerName" TEXT,
  "labelValue" TEXT,
  "identification" TEXT NOT NULL DEFAULT 'UNCONFIRMED',
  "runtimeState" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "instances" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "discoveryError" TEXT,
  "lastDiscoveredAt" TIMESTAMPTZ(3),
  "lastAttemptedAt" TIMESTAMPTZ(3),
  "lastSeenAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Resource_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Resource_nodeId_locatorKey_key" ON "Resource"("nodeId", "locatorKey");
CREATE INDEX "Resource_nodeId_type_idx" ON "Resource"("nodeId", "type");
CREATE TABLE "ApplicationResource" (
  "applicationId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("applicationId", "resourceId"),
  CONSTRAINT "ApplicationResource_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ApplicationResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ApplicationResource_resourceId_idx" ON "ApplicationResource"("resourceId");
ALTER TABLE "Deployment" ADD COLUMN "resourceId" TEXT;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DockerOperation" ADD COLUMN "resourceId" TEXT;
ALTER TABLE "DockerOperation" ADD COLUMN "resolvedContainerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DockerOperation" ADD CONSTRAINT "DockerOperation_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only identical historical node/type/target references are consolidated.
-- No old container ID is promoted to a durable name, label or Compose rule.
CREATE TEMP TABLE "_ResourceMigration" AS
SELECT "nodeId", "type", "target", gen_random_uuid()::text AS "resourceId", min("name") AS "name"
FROM "Deployment" GROUP BY "nodeId", "type", "target";
INSERT INTO "Resource" ("id", "nodeId", "name", "type", "strategy", "metadata", "updatedAt")
SELECT "resourceId", "nodeId", "name", "type", 'unconfirmed',
       jsonb_build_object('legacyTarget', "target"), CURRENT_TIMESTAMP
FROM "_ResourceMigration";
UPDATE "Deployment" d SET "resourceId" = r."resourceId"
FROM "_ResourceMigration" r
WHERE d."nodeId" = r."nodeId" AND d."type" = r."type" AND d."target" = r."target";
INSERT INTO "ApplicationResource" ("applicationId", "resourceId")
SELECT DISTINCT "applicationId", "resourceId" FROM "Deployment";
DROP TABLE "_ResourceMigration";
