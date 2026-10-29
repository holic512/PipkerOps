-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "scheduleId" TEXT;

-- CreateIndex
CREATE INDEX "Task_scheduleId_createdAt_idx" ON "Task"("scheduleId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
