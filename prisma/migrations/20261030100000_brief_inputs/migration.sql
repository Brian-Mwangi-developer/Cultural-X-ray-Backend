-- AlterTable
ALTER TABLE "brief" ADD COLUMN "occasion" TEXT,
ADD COLUMN "placements" TEXT[];

-- AlterTable
ALTER TABLE "brief_item" ADD COLUMN "refs" JSONB;
