CREATE TABLE "NodeFolder" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "parentId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "NodeFolder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NodeFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "NodeFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NodeFolder_not_self" CHECK ("parentId" IS DISTINCT FROM "id")
);
CREATE UNIQUE INDEX "NodeFolder_parentId_name_key" ON "NodeFolder"("parentId", "name");
CREATE UNIQUE INDEX "NodeFolder_root_name_key" ON "NodeFolder"("name") WHERE "parentId" IS NULL;
ALTER TABLE "Node" ADD COLUMN "folderId" TEXT;
ALTER TABLE "Node" ADD CONSTRAINT "Node_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "NodeFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Node_folderId_idx" ON "Node"("folderId");
