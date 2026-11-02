CREATE TYPE "DockerOperationStatus" AS ENUM ('REQUESTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

CREATE TABLE "DockerOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "method" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "actorId" TEXT,
  "apiKeyId" TEXT,
  "source" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "action" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "DockerOperationStatus" NOT NULL DEFAULT 'REQUESTED',
  "output" TEXT NOT NULL DEFAULT '',
  "error" TEXT,
  "result" JSONB NOT NULL DEFAULT '{}',
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "startedAt" TIMESTAMPTZ(3),
  "finishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "DockerOperation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DockerOperation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DockerOperation_idempotencyKey_key" ON "DockerOperation"("idempotencyKey");
CREATE INDEX "DockerOperation_nodeId_createdAt_idx" ON "DockerOperation"("nodeId", "createdAt" DESC);

CREATE TABLE "DockerOperationLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "operationId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "stream" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DockerOperationLog_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "DockerOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DockerOperationLog_operationId_sequence_key" ON "DockerOperationLog"("operationId", "sequence");
