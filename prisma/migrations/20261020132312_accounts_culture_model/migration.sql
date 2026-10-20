-- CreateEnum
CREATE TYPE "OrgKind" AS ENUM ('AGENCY', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "Market" AS ENUM ('US', 'GB');

-- CreateEnum
CREATE TYPE "AccessLevel" AS ENUM ('VIEW', 'EDIT', 'MANAGE');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'DECLINED', 'ENDED');

-- CreateEnum
CREATE TYPE "ConnectionOrigin" AS ENUM ('AGENCY_REQUEST', 'WORKSPACE_CODE', 'AGENCY_CREATED');

-- CreateEnum
CREATE TYPE "EndedBy" AS ENUM ('AGENCY', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'CLAIMED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'OWNER', 'AGENCY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE', 'READ_ONLY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('MAP_BUILD', 'AD_CHECK', 'BRIEF', 'LOCALIZE', 'OTHER');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('BRAND', 'PODCAST', 'PERSON', 'MOVIE', 'TV_SHOW', 'ARTIST', 'DESTINATION', 'PLACE', 'BOOK', 'VIDEOGAME', 'TAG');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('OK', 'WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "MapStatus" AS ENUM ('QUEUED', 'BUILDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SubjectRole" AS ENUM ('SELF', 'SEED', 'RIVAL');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('MAINSTREAM', 'NICHE');

-- CreateEnum
CREATE TYPE "Territory" AS ENUM ('YOURS', 'CONTESTED', 'THEIRS');

-- CreateEnum
CREATE TYPE "GeoKind" AS ENUM ('DESTINATION', 'CITY', 'HEATMAP');

-- CreateEnum
CREATE TYPE "PlayKind" AS ENUM ('CREATOR', 'PODCAST', 'SHOW', 'ARTIST', 'PLACE', 'AESTHETIC', 'PARTNER', 'PRICE', 'SOUND');

-- CreateEnum
CREATE TYPE "PlayStatus" AS ENUM ('SUGGESTED', 'PINNED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "BriefStatus" AS ENUM ('DRAFT', 'SHARED', 'EXPORTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ClaimState" AS ENUM ('CITED', 'UNCITED', 'REJECTED', 'TAINTED', 'INSIGHT_ONLY');

-- CreateEnum
CREATE TYPE "AdSource" AS ENUM ('DRAFT', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ElementKind" AS ENUM ('SETTING', 'STYLING', 'SCRIPT', 'ONSCREEN_TEXT', 'SOUND', 'CREATOR', 'REFERENCE', 'LOGO');

-- CreateEnum
CREATE TYPE "RightsFlag" AS ENUM ('NONE', 'COMMERCIAL_TRACK');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'CRITIC', 'TOOL');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('MAP_READY', 'MAP_AGEING', 'CRITIC_FLAG', 'SCAN_DONE', 'CONNECTION_REQUEST', 'CONNECTION_CHANGED', 'CLAIM_PENDING', 'BILLING');

-- CreateEnum
CREATE TYPE "PinTarget" AS ENUM ('MAP', 'TERRITORY_ITEM', 'PLAY', 'BRIEF', 'AD_CHECK');

-- CreateEnum
CREATE TYPE "Theme" AS ENUM ('LIGHT', 'DARK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Density" AS ENUM ('COMFORTABLE', 'COMPACT');

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "activeOrganizationId" TEXT;

-- CreateTable
CREATE TABLE "user_preference" (
    "userId" TEXT NOT NULL,
    "theme" "Theme" NOT NULL DEFAULT 'SYSTEM',
    "density" "Density" NOT NULL DEFAULT 'COMFORTABLE',
    "reduceMotion" BOOLEAN NOT NULL DEFAULT false,
    "showEvidenceInline" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "region" TEXT NOT NULL DEFAULT 'US',
    "defaultMarket" "Market" NOT NULL DEFAULT 'US',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "kind" "OrgKind" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "hqCountry" TEXT,
    "teamSize" TEXT,
    "billingEmail" TEXT,
    "markets" "Market"[],
    "joinDomain" TEXT,
    "joinRole" TEXT,
    "connectCode" TEXT,
    "brandEntityId" TEXT,
    "custodianId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "allClients" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "allClients" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'REQUESTED',
    "origin" "ConnectionOrigin" NOT NULL,
    "accessRequested" "AccessLevel" NOT NULL,
    "access" "AccessLevel",
    "requestedById" TEXT,
    "decidedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" "EndedBy",
    "endReason" TEXT,
    "agencyKeepsPdf" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_client_access" (
    "memberId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_client_access_pkey" PRIMARY KEY ("memberId","connectionId")
);

-- CreateTable
CREATE TABLE "invitation_client_access" (
    "invitationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "invitation_client_access_pkey" PRIMARY KEY ("invitationId","connectionId")
);

-- CreateTable
CREATE TABLE "workspace_claim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "requestedAccess" "AccessLevel" NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "seats" INTEGER NOT NULL DEFAULT 1,
    "monthlyQueryAllowance" INTEGER NOT NULL DEFAULT 1000,
    "currentPeriodEnd" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "externalCustomerId" TEXT,
    "externalSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mapId" TEXT,
    "kind" "UsageKind" NOT NULL,
    "calls" INTEGER NOT NULL,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qloo_entity" (
    "id" TEXT NOT NULL,
    "kind" "EntityKind" NOT NULL,
    "name" TEXT NOT NULL,
    "subtype" TEXT,
    "popularity" DOUBLE PRECISION,
    "imageUrl" TEXT,
    "externalIds" JSONB,
    "properties" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qloo_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qloo_cache" (
    "key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "response" JSONB NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "qloo_cache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "path" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "cacheKey" TEXT,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'OK',
    "warnings" JSONB,
    "placeholderMasked" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "culture_map" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "market" "Market" NOT NULL,
    "status" "MapStatus" NOT NULL DEFAULT 'QUEUED',
    "thinData" BOOLEAN NOT NULL DEFAULT false,
    "categoriesDone" INTEGER NOT NULL DEFAULT 0,
    "categoriesTotal" INTEGER NOT NULL DEFAULT 8,
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "builtAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "culture_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "map_subject" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "role" "SubjectRole" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "map_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "association" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "category" "EntityKind" NOT NULL,
    "tier" "Tier" NOT NULL DEFAULT 'MAINSTREAM',
    "segment" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "rank" INTEGER NOT NULL,
    "affinity" DOUBLE PRECISION NOT NULL,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "association_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "territory_item" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "category" "EntityKind" NOT NULL,
    "segment" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "tier" "Tier" NOT NULL DEFAULT 'MAINSTREAM',
    "label" "Territory" NOT NULL,
    "leanSelf" DOUBLE PRECISION,
    "rivalSubjectId" TEXT,
    "evidenceId" TEXT,

    CONSTRAINT "territory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audience_index" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "lowConfidence" BOOLEAN NOT NULL DEFAULT false,
    "placeholderMasked" BOOLEAN NOT NULL DEFAULT false,
    "insightOnly" BOOLEAN NOT NULL DEFAULT false,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "audience_index_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_signal" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" "GeoKind" NOT NULL,
    "entityId" TEXT,
    "label" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "rank" INTEGER,
    "payload" JSONB,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "geo_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "map_reading" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "category" "EntityKind",
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "play" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "kind" "PlayKind" NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "entityId" TEXT,
    "status" "PlayStatus" NOT NULL DEFAULT 'SUGGESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "play_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mapId" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "segment" TEXT,
    "cities" TEXT[],
    "market" "Market" NOT NULL,
    "status" "BriefStatus" NOT NULL DEFAULT 'DRAFT',
    "authorId" TEXT,
    "authorOrgId" TEXT,
    "shareToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_item" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "kind" "PlayKind",
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "playId" TEXT,
    "state" "ClaimState" NOT NULL DEFAULT 'UNCITED',
    "criticNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brief_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mapId" TEXT,
    "title" TEXT NOT NULL,
    "source" "AdSource" NOT NULL DEFAULT 'DRAFT',
    "competitorEntityId" TEXT,
    "storageKey" TEXT NOT NULL,
    "durationMs" INTEGER,
    "status" "AdStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_element" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "kind" "ElementKind" NOT NULL,
    "raw" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "salience" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "entityId" TEXT,
    "tagId" TEXT,
    "territory" "Territory",
    "offMap" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ad_element_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_check" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "yoursPct" DOUBLE PRECISION NOT NULL,
    "contestedPct" DOUBLE PRECISION NOT NULL,
    "theirsPct" DOUBLE PRECISION NOT NULL,
    "offMapPct" DOUBLE PRECISION NOT NULL,
    "rightsFlag" "RightsFlag" NOT NULL DEFAULT 'NONE',
    "rightsDetail" TEXT,
    "blame" JSONB NOT NULL,
    "fixes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ask_thread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mapId" TEXT,
    "briefId" TEXT,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ask_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ask_message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "parts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ask_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetType" "PinTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_EvidenceToMapReading" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_EvidenceToMapReading_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_EvidenceToPlay" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_EvidenceToPlay_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_BriefItemToEvidence" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BriefItemToEvidence_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "organization_kind_idx" ON "organization"("kind");

-- CreateIndex
CREATE INDEX "organization_custodianId_idx" ON "organization"("custodianId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organization_connectCode_key" ON "organization"("connectCode");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE INDEX "connection_workspaceId_status_idx" ON "connection"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "connection_agencyId_workspaceId_key" ON "connection"("agencyId", "workspaceId");

-- CreateIndex
CREATE INDEX "member_client_access_connectionId_idx" ON "member_client_access"("connectionId");

-- CreateIndex
CREATE INDEX "workspace_claim_workspaceId_status_idx" ON "workspace_claim"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "workspace_claim_email_idx" ON "workspace_claim"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_claim_tokenHash_key" ON "workspace_claim"("tokenHash");

-- CreateIndex
CREATE INDEX "subscription_payerId_idx" ON "subscription"("payerId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_organizationId_key" ON "subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_externalSubscriptionId_key" ON "subscription"("externalSubscriptionId");

-- CreateIndex
CREATE INDEX "usage_ledger_payerId_createdAt_idx" ON "usage_ledger"("payerId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_ledger_workspaceId_createdAt_idx" ON "usage_ledger"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "qloo_entity_kind_name_idx" ON "qloo_entity"("kind", "name");

-- CreateIndex
CREATE INDEX "qloo_cache_path_idx" ON "qloo_cache"("path");

-- CreateIndex
CREATE INDEX "evidence_cacheKey_idx" ON "evidence"("cacheKey");

-- CreateIndex
CREATE INDEX "culture_map_workspaceId_createdAt_idx" ON "culture_map"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "map_subject_mapId_entityId_key" ON "map_subject"("mapId", "entityId");

-- CreateIndex
CREATE INDEX "association_mapId_category_segment_city_idx" ON "association"("mapId", "category", "segment", "city");

-- CreateIndex
CREATE UNIQUE INDEX "association_subjectId_entityId_category_tier_segment_city_key" ON "association"("subjectId", "entityId", "category", "tier", "segment", "city");

-- CreateIndex
CREATE INDEX "territory_item_mapId_category_label_idx" ON "territory_item"("mapId", "category", "label");

-- CreateIndex
CREATE UNIQUE INDEX "territory_item_mapId_entityId_category_tier_segment_city_key" ON "territory_item"("mapId", "entityId", "category", "tier", "segment", "city");

-- CreateIndex
CREATE INDEX "audience_index_mapId_idx" ON "audience_index"("mapId");

-- CreateIndex
CREATE UNIQUE INDEX "audience_index_subjectId_audience_key" ON "audience_index"("subjectId", "audience");

-- CreateIndex
CREATE INDEX "geo_signal_mapId_kind_idx" ON "geo_signal"("mapId", "kind");

-- CreateIndex
CREATE INDEX "map_reading_mapId_idx" ON "map_reading"("mapId");

-- CreateIndex
CREATE INDEX "play_mapId_kind_rank_idx" ON "play"("mapId", "kind", "rank");

-- CreateIndex
CREATE INDEX "brief_workspaceId_updatedAt_idx" ON "brief"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "brief_shareToken_key" ON "brief"("shareToken");

-- CreateIndex
CREATE INDEX "brief_item_briefId_position_idx" ON "brief_item"("briefId", "position");

-- CreateIndex
CREATE INDEX "ad_workspaceId_createdAt_idx" ON "ad"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ad_element_adId_kind_idx" ON "ad_element"("adId", "kind");

-- CreateIndex
CREATE INDEX "ad_check_adId_idx" ON "ad_check"("adId");

-- CreateIndex
CREATE INDEX "ask_thread_workspaceId_userId_updatedAt_idx" ON "ask_thread"("workspaceId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ask_message_threadId_createdAt_idx" ON "ask_message"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_userId_readAt_createdAt_idx" ON "notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "pin_organizationId_idx" ON "pin"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "pin_userId_targetType_targetId_key" ON "pin"("userId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_event_organizationId_createdAt_idx" ON "audit_event"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "_EvidenceToMapReading_B_index" ON "_EvidenceToMapReading"("B");

-- CreateIndex
CREATE INDEX "_EvidenceToPlay_B_index" ON "_EvidenceToPlay"("B");

-- CreateIndex
CREATE INDEX "_BriefItemToEvidence_B_index" ON "_BriefItemToEvidence"("B");

-- AddForeignKey
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_brandEntityId_fkey" FOREIGN KEY ("brandEntityId") REFERENCES "qloo_entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_client_access" ADD CONSTRAINT "member_client_access_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_client_access" ADD CONSTRAINT "member_client_access_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_client_access" ADD CONSTRAINT "invitation_client_access_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_client_access" ADD CONSTRAINT "invitation_client_access_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_claim" ADD CONSTRAINT "workspace_claim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_claim" ADD CONSTRAINT "workspace_claim_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_claim" ADD CONSTRAINT "workspace_claim_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_claim" ADD CONSTRAINT "workspace_claim_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_cacheKey_fkey" FOREIGN KEY ("cacheKey") REFERENCES "qloo_cache"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "culture_map" ADD CONSTRAINT "culture_map_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "culture_map" ADD CONSTRAINT "culture_map_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_subject" ADD CONSTRAINT "map_subject_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_subject" ADD CONSTRAINT "map_subject_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "association" ADD CONSTRAINT "association_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "association" ADD CONSTRAINT "association_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "map_subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "association" ADD CONSTRAINT "association_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "association" ADD CONSTRAINT "association_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_item" ADD CONSTRAINT "territory_item_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_item" ADD CONSTRAINT "territory_item_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_item" ADD CONSTRAINT "territory_item_rivalSubjectId_fkey" FOREIGN KEY ("rivalSubjectId") REFERENCES "map_subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_item" ADD CONSTRAINT "territory_item_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_index" ADD CONSTRAINT "audience_index_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_index" ADD CONSTRAINT "audience_index_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "map_subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_index" ADD CONSTRAINT "audience_index_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_signal" ADD CONSTRAINT "geo_signal_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_signal" ADD CONSTRAINT "geo_signal_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "map_subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_signal" ADD CONSTRAINT "geo_signal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_signal" ADD CONSTRAINT "geo_signal_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_reading" ADD CONSTRAINT "map_reading_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "play" ADD CONSTRAINT "play_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "play" ADD CONSTRAINT "play_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief" ADD CONSTRAINT "brief_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief" ADD CONSTRAINT "brief_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief" ADD CONSTRAINT "brief_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief" ADD CONSTRAINT "brief_authorOrgId_fkey" FOREIGN KEY ("authorOrgId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_item" ADD CONSTRAINT "brief_item_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_item" ADD CONSTRAINT "brief_item_playId_fkey" FOREIGN KEY ("playId") REFERENCES "play"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "ad_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "ad_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "ad_competitorEntityId_fkey" FOREIGN KEY ("competitorEntityId") REFERENCES "qloo_entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "ad_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_element" ADD CONSTRAINT "ad_element_adId_fkey" FOREIGN KEY ("adId") REFERENCES "ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_element" ADD CONSTRAINT "ad_element_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "qloo_entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_check" ADD CONSTRAINT "ad_check_adId_fkey" FOREIGN KEY ("adId") REFERENCES "ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_check" ADD CONSTRAINT "ad_check_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_thread" ADD CONSTRAINT "ask_thread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_thread" ADD CONSTRAINT "ask_thread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_thread" ADD CONSTRAINT "ask_thread_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "culture_map"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_thread" ADD CONSTRAINT "ask_thread_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "brief"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_message" ADD CONSTRAINT "ask_message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ask_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin" ADD CONSTRAINT "pin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin" ADD CONSTRAINT "pin_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EvidenceToMapReading" ADD CONSTRAINT "_EvidenceToMapReading_A_fkey" FOREIGN KEY ("A") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EvidenceToMapReading" ADD CONSTRAINT "_EvidenceToMapReading_B_fkey" FOREIGN KEY ("B") REFERENCES "map_reading"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EvidenceToPlay" ADD CONSTRAINT "_EvidenceToPlay_A_fkey" FOREIGN KEY ("A") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EvidenceToPlay" ADD CONSTRAINT "_EvidenceToPlay_B_fkey" FOREIGN KEY ("B") REFERENCES "play"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BriefItemToEvidence" ADD CONSTRAINT "_BriefItemToEvidence_A_fkey" FOREIGN KEY ("A") REFERENCES "brief_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BriefItemToEvidence" ADD CONSTRAINT "_BriefItemToEvidence_B_fkey" FOREIGN KEY ("B") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
