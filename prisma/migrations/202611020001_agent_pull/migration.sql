-- 保留旧注册数据，已有节点通过重新导入接入文件继续关联原历史。
ALTER TABLE "Node" ADD COLUMN "agentId" TEXT,
  ADD COLUMN "agentUrl" TEXT,
  ADD COLUMN "agentCaPem" TEXT,
  ADD COLUMN "agentCredentialRef" TEXT,
  ADD COLUMN "deployRoot" TEXT,
  ADD COLUMN "connectionError" TEXT;
CREATE UNIQUE INDEX "Node_agentId_key" ON "Node"("agentId");
