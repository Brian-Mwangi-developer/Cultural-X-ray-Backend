-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'LOOKUP';

-- AlterTable
ALTER TABLE "usage_ledger" ADD COLUMN     "path" TEXT,
ADD COLUMN     "userId" TEXT;
