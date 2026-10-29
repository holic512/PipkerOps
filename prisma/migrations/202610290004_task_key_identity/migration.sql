-- Preserve the originating key identity after key deletion. An absent key must
-- fail execution-time authorization, never fall back to the owning user's role.
ALTER TABLE "Task" DROP CONSTRAINT "Task_apiKeyId_fkey";
