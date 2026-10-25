/*
  Warnings:

  - You are about to drop the column `blame` on the `ad_check` table. All the data in the column will be lost.
  - You are about to drop the column `contestedPct` on the `ad_check` table. All the data in the column will be lost.
  - You are about to drop the column `fixes` on the `ad_check` table. All the data in the column will be lost.
  - You are about to drop the column `offMapPct` on the `ad_check` table. All the data in the column will be lost.
  - You are about to drop the column `theirsPct` on the `ad_check` table. All the data in the column will be lost.
  - You are about to drop the column `yoursPct` on the `ad_check` table. All the data in the column will be lost.
  - Added the required column `verdict` to the `ad_check` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "RecutKind" AS ENUM ('RECOMMENDED', 'SHORTEST', 'BOLDEST', 'CUSTOM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdStatus" ADD VALUE 'UPLOADING';
ALTER TYPE "AdStatus" ADD VALUE 'QUEUED';
ALTER TYPE "AdStatus" ADD VALUE 'READING';

-- AlterTable
ALTER TABLE "ad" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "placements" TEXT[],
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "rivals" JSONB,
ADD COLUMN     "sizeBytes" INTEGER,
ADD COLUMN     "stage" TEXT,
ADD COLUMN     "videoDeletedAt" TIMESTAMP(3),
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "ad_check" DROP COLUMN "blame",
DROP COLUMN "contestedPct",
DROP COLUMN "fixes",
DROP COLUMN "offMapPct",
DROP COLUMN "theirsPct",
DROP COLUMN "yoursPct",
ADD COLUMN     "verdict" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "ad_element" ADD COLUMN     "detail" JSONB,
ALTER COLUMN "salience" SET DEFAULT 0,
ALTER COLUMN "confidence" SET DEFAULT 1;

-- CreateTable
CREATE TABLE "ad_shot" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "description" JSONB,
    "territory" "Territory",
    "evidence" JSONB,

    CONSTRAINT "ad_shot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recut" (
    "id" TEXT NOT NULL,
    "adCheckId" TEXT NOT NULL,
    "kind" "RecutKind" NOT NULL,
    "editList" JSONB NOT NULL,
    "verdict" JSONB,
    "parentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_call" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "feature" "UsageKind" NOT NULL,
    "userId" TEXT,
    "workspaceId" TEXT,
    "adId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "thoughtTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_shot_adId_index_key" ON "ad_shot"("adId", "index");

-- CreateIndex
CREATE INDEX "recut_adCheckId_createdAt_idx" ON "recut"("adCheckId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_call_userId_createdAt_idx" ON "ai_call"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_call_workspaceId_createdAt_idx" ON "ai_call"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_call_createdAt_idx" ON "ai_call"("createdAt");

-- AddForeignKey
ALTER TABLE "ad_shot" ADD CONSTRAINT "ad_shot_adId_fkey" FOREIGN KEY ("adId") REFERENCES "ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recut" ADD CONSTRAINT "recut_adCheckId_fkey" FOREIGN KEY ("adCheckId") REFERENCES "ad_check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recut" ADD CONSTRAINT "recut_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call" ADD CONSTRAINT "ai_call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call" ADD CONSTRAINT "ai_call_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
