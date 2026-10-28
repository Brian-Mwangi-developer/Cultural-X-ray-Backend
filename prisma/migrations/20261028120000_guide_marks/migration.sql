-- CreateTable
CREATE TABLE "guide_mark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL DEFAULT '',
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_mark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guide_mark_userId_workspaceId_key_key" ON "guide_mark"("userId", "workspaceId", "key");

-- AddForeignKey
ALTER TABLE "guide_mark" ADD CONSTRAINT "guide_mark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
