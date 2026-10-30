-- AlterTable
ALTER TABLE "organization" ADD COLUMN "reportShareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "organization_reportShareToken_key" ON "organization"("reportShareToken");
