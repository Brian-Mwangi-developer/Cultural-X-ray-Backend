-- CreateTable
CREATE TABLE "guide_memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'said',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guide_memory_userId_workspaceId_createdAt_idx" ON "guide_memory"("userId", "workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "guide_memory" ADD CONSTRAINT "guide_memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
