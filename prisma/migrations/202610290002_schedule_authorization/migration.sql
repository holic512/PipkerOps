ALTER TABLE "Schedule" ADD COLUMN "createdByApiKeyId" TEXT;
CREATE INDEX "Schedule_createdByApiKeyId_idx" ON "Schedule"("createdByApiKeyId");
