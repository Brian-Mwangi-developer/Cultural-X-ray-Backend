-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'PLAYS';

-- AlterTable
ALTER TABLE "play" ADD COLUMN     "brief" JSONB,
ADD COLUMN     "items" JSONB,
ADD COLUMN     "why" TEXT;

-- CreateTable
CREATE TABLE "creator_profile" (
    "entityId" TEXT NOT NULL,
    "description" TEXT,
    "instagram" TEXT,
    "twitter" TEXT,
    "facebook" TEXT,
    "youtubeChannel" TEXT,
    "youtubeHandle" TEXT,
    "youtubeTitle" TEXT,
    "subscribers" TEXT,
    "youtubeMatch" TEXT,
    "tiktokHandle" TEXT,
    "tiktokName" TEXT,
    "tiktokMatch" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_profile_pkey" PRIMARY KEY ("entityId")
);

-- AddForeignKey
ALTER TABLE "creator_profile" ADD CONSTRAINT "creator_profile_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
