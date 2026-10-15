-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BaseRole" AS ENUM ('farmer', 'dco', 'organization_admin', 'platform_admin');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('local', 'google');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('draft', 'pending_verification', 'complete');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('not_submitted', 'pending', 'verified', 'rejected', 'manual_review');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('nin', 'cac');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('account_creation', 'farm_data_collection');

-- CreateEnum
CREATE TYPE "ConsentDecision" AS ENUM ('accepted', 'rejected');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('nin', 'cac_certificate', 'cac_form2', 'cac_form7', 'utility_bill', 'passport_photo', 'observation_evidence', 'crop_image', 'other');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('not_verified', 'pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "ImportEntityType" AS ENUM ('farmer', 'dco', 'organization', 'member');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('validated', 'failed', 'committing', 'committed');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('valid', 'invalid', 'duplicate', 'committed', 'failed');

-- CreateEnum
CREATE TYPE "VisitRequestMode" AS ENUM ('known_farms', 'geographic_preference');

-- CreateEnum
CREATE TYPE "VisitRequestStatus" AS ENUM ('pending_assignment', 'partially_assigned', 'assigned', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('assigned', 'accepted', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "FarmVisitStatus" AS ENUM ('in_progress', 'completed', 'ended_early');

-- CreateEnum
CREATE TYPE "ObservationType" AS ENUM ('disease', 'pest');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "AreaUnit" AS ENUM ('hectare', 'acre', 'square_meter');

-- CreateEnum
CREATE TYPE "AiCrop" AS ENUM ('rice', 'maize', 'tomato');

-- CreateEnum
CREATE TYPE "AiModelStatus" AS ENUM ('registered', 'approved', 'active', 'retired');

-- CreateEnum
CREATE TYPE "AiPredictionStatus" AS ENUM ('succeeded', 'failed');

-- CreateEnum
CREATE TYPE "GroupMemberType" AS ENUM ('farmer', 'dco', 'organization');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'sms', 'whatsapp', 'email');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "IssuedAgriksenseId" (
    "id" CHAR(10) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedAgriksenseId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "agriksenseId" CHAR(10) NOT NULL,
    "baseRole" "BaseRole" NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT,
    "authProvider" "AuthProvider" NOT NULL DEFAULT 'local',
    "googleSubject" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'draft',
    "ninStatus" "VerificationStatus" NOT NULL DEFAULT 'not_submitted',
    "firstName" TEXT,
    "lastName" TEXT,
    "otherName" TEXT,
    "altPhone" TEXT,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "stateId" INTEGER,
    "lgaId" INTEGER,
    "photoDocumentId" UUID,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmerProfile" (
    "userId" UUID NOT NULL,
    "managerName" TEXT,
    "managerPhone" TEXT,
    "managerEmail" TEXT,
    "farmingGroup" TEXT,
    "primaryCrops" TEXT[],
    "yearsFarming" INTEGER,

    CONSTRAINT "FarmerProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "DcoProfile" (
    "userId" UUID NOT NULL,
    "availability" JSONB,
    "hasTransport" BOOLEAN,
    "educationLevel" TEXT,

    CONSTRAINT "DcoProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "initiatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentDocument" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "decision" "ConsentDecision" NOT NULL,
    "actorId" UUID NOT NULL,
    "channel" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" UUID,
    "withdrawReason" TEXT,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityVerification" (
    "id" UUID NOT NULL,
    "type" "VerificationType" NOT NULL,
    "userId" UUID NOT NULL,
    "organizationId" UUID,
    "status" "VerificationStatus" NOT NULL DEFAULT 'pending',
    "numberEncrypted" TEXT NOT NULL,
    "numberHash" TEXT NOT NULL,
    "numberLast4" TEXT NOT NULL,
    "nameSubmitted" TEXT,
    "nameMatch" TEXT,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "failureReason" TEXT,
    "documentIds" TEXT[],
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdentityVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "organizationId" UUID,
    "type" "DocumentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "State" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lga" (
    "id" SERIAL NOT NULL,
    "stateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Lga_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" SERIAL NOT NULL,
    "lgaId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bankId" INTEGER NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT NOT NULL,
    "accountNumberHash" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isRegistered" BOOLEAN NOT NULL DEFAULT false,
    "cacStatus" "VerificationStatus" NOT NULL DEFAULT 'not_submitted',
    "headquartersAddress" TEXT,
    "city" TEXT,
    "stateId" INTEGER,
    "lgaId" INTEGER,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationContact" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "contactType" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "position" TEXT,
    "ninEncrypted" TEXT,
    "ninLast4" TEXT,
    "ninDocumentId" UUID,
    "utilityBillDocumentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "farmerId" UUID,
    "membershipNumber" TEXT NOT NULL,
    "isGeneratedNumber" BOOLEAN NOT NULL DEFAULT false,
    "memberName" TEXT,
    "memberPhone" TEXT,
    "status" "MembershipStatus" NOT NULL DEFAULT 'not_verified',
    "statusReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" UUID,
    "joinedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "entityType" "ImportEntityType" NOT NULL,
    "status" "ImportJobStatus" NOT NULL,
    "organizationId" UUID,
    "createdById" UUID NOT NULL,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "committedRows" INTEGER NOT NULL DEFAULT 0,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "errors" JSONB,
    "createdEntityId" TEXT,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Farm" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "landmark" TEXT,
    "village" TEXT,
    "city" TEXT NOT NULL,
    "lgaId" INTEGER NOT NULL,
    "stateId" INTEGER NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Farm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitRequest" (
    "id" UUID NOT NULL,
    "dcoId" UUID NOT NULL,
    "mode" "VisitRequestMode" NOT NULL,
    "knownFarms" JSONB,
    "preferredStateId" INTEGER,
    "preferredLgaId" INTEGER,
    "preferredCity" TEXT,
    "maxFarms" INTEGER,
    "availability" JSONB,
    "notes" TEXT,
    "status" "VisitRequestStatus" NOT NULL DEFAULT 'pending_assignment',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmAssignment" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "dcoId" UUID NOT NULL,
    "visitRequestId" UUID,
    "assignedById" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'assigned',
    "scheduledFor" TIMESTAMP(3),
    "fareKobo" INTEGER,
    "distanceValue" DOUBLE PRECISION,
    "distanceUnit" TEXT,
    "fareRateKoboPerUnit" INTEGER,
    "fareBasis" JSONB,
    "notes" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FarmAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FareRate" (
    "id" UUID NOT NULL,
    "stateId" INTEGER NOT NULL,
    "koboPerMile" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "setById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FareRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmVisit" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "assignmentId" UUID,
    "dcoId" UUID NOT NULL,
    "status" "FarmVisitStatus" NOT NULL DEFAULT 'in_progress',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "notes" TEXT,
    "endReason" TEXT,
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "dataCollected" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FarmVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CropRecord" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "visitId" UUID,
    "cropType" TEXT NOT NULL,
    "variety" TEXT,
    "season" TEXT,
    "plantingDate" DATE,
    "expectedHarvestDate" DATE,
    "areaPlanted" DOUBLE PRECISION,
    "areaUnit" "AreaUnit",
    "growthStage" TEXT,
    "notes" TEXT,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CropRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmlandMeasurement" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "visitId" UUID,
    "area" DOUBLE PRECISION NOT NULL,
    "areaUnit" "AreaUnit" NOT NULL,
    "areaHectares" DOUBLE PRECISION NOT NULL,
    "perimeterMeters" DOUBLE PRECISION,
    "soilType" TEXT,
    "terrain" TEXT,
    "irrigation" TEXT,
    "measurementMethod" TEXT,
    "boundary" JSONB,
    "recordedById" UUID NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmlandMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "cropRecordId" UUID,
    "visitId" UUID,
    "predictionId" UUID,
    "type" "ObservationType" NOT NULL,
    "name" TEXT NOT NULL,
    "cropType" TEXT,
    "severity" "Severity",
    "affectedAreaPercent" DOUBLE PRECISION,
    "description" TEXT,
    "evidenceDocumentIds" TEXT[],
    "annotations" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelVersion" (
    "id" UUID NOT NULL,
    "crop" "AiCrop" NOT NULL,
    "version" TEXT NOT NULL,
    "serviceUrl" TEXT NOT NULL,
    "classes" TEXT[],
    "status" "AiModelStatus" NOT NULL DEFAULT 'registered',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "activatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelEvaluation" (
    "id" UUID NOT NULL,
    "modelVersionId" UUID NOT NULL,
    "metrics" JSONB NOT NULL,
    "evidenceUrl" TEXT,
    "notes" TEXT,
    "signedOffById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiModelEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPrediction" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "farmId" UUID,
    "crop" "AiCrop" NOT NULL,
    "modelVersionId" UUID NOT NULL,
    "imageDocumentId" UUID,
    "status" "AiPredictionStatus" NOT NULL,
    "detections" JSONB NOT NULL,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "latencyMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiFeedback" (
    "id" UUID NOT NULL,
    "predictionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "correctedClassName" TEXT,
    "detectionIndex" INTEGER,
    "notes" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionKey")
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "assignedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "memberType" "GroupMemberType" NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "addedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "provider" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'queued',
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_agriksenseId_key" ON "User"("agriksenseId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");

-- CreateIndex
CREATE INDEX "User_baseRole_idx" ON "User"("baseRole");

-- CreateIndex
CREATE INDEX "User_stateId_lgaId_idx" ON "User"("stateId", "lgaId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentDocument_version_scope_language_key" ON "ConsentDocument"("version", "scope", "language");

-- CreateIndex
CREATE INDEX "Consent_userId_scope_idx" ON "Consent"("userId", "scope");

-- CreateIndex
CREATE INDEX "IdentityVerification_userId_type_idx" ON "IdentityVerification"("userId", "type");

-- CreateIndex
CREATE INDEX "IdentityVerification_numberHash_idx" ON "IdentityVerification"("numberHash");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_ownerId_idx" ON "Document"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "State_name_key" ON "State"("name");

-- CreateIndex
CREATE UNIQUE INDEX "State_code_key" ON "State"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Lga_stateId_name_key" ON "Lga"("stateId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "City_lgaId_name_key" ON "City"("lgaId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_name_key" ON "Bank"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_code_key" ON "Bank"("code");

-- CreateIndex
CREATE INDEX "BankAccount_userId_idx" ON "BankAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_ownerUserId_key" ON "Organization"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_membershipNumber_key" ON "OrganizationMembership"("organizationId", "membershipNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_farmerId_key" ON "OrganizationMembership"("organizationId", "farmerId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_jobId_rowNumber_key" ON "ImportRow"("jobId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");

-- CreateIndex
CREATE INDEX "Farm_stateId_lgaId_idx" ON "Farm"("stateId", "lgaId");

-- CreateIndex
CREATE INDEX "Farm_ownerId_idx" ON "Farm"("ownerId");

-- CreateIndex
CREATE INDEX "VisitRequest_status_idx" ON "VisitRequest"("status");

-- CreateIndex
CREATE INDEX "FarmAssignment_dcoId_status_idx" ON "FarmAssignment"("dcoId", "status");

-- CreateIndex
CREATE INDEX "FarmAssignment_farmId_idx" ON "FarmAssignment"("farmId");

-- CreateIndex
CREATE UNIQUE INDEX "FareRate_stateId_effectiveFrom_key" ON "FareRate"("stateId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "FarmVisit_farmId_idx" ON "FarmVisit"("farmId");

-- CreateIndex
CREATE INDEX "CropRecord_farmId_idx" ON "CropRecord"("farmId");

-- CreateIndex
CREATE INDEX "CropRecord_cropType_idx" ON "CropRecord"("cropType");

-- CreateIndex
CREATE INDEX "FarmlandMeasurement_farmId_idx" ON "FarmlandMeasurement"("farmId");

-- CreateIndex
CREATE INDEX "Observation_farmId_idx" ON "Observation"("farmId");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelVersion_crop_version_key" ON "AiModelVersion"("crop", "version");

-- CreateIndex
CREATE INDEX "AiPrediction_userId_idx" ON "AiPrediction"("userId");

-- CreateIndex
CREATE INDEX "AiPrediction_farmId_idx" ON "AiPrediction"("farmId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_providerMessageId_key" ON "NotificationDelivery"("providerMessageId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "Lga"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerProfile" ADD CONSTRAINT "FarmerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DcoProfile" ADD CONSTRAINT "DcoProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lga" ADD CONSTRAINT "Lga_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "Lga"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "Lga"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationContact" ADD CONSTRAINT "OrganizationContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_farmerId_fkey" FOREIGN KEY ("farmerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "Lga"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitRequest" ADD CONSTRAINT "VisitRequest_dcoId_fkey" FOREIGN KEY ("dcoId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmAssignment" ADD CONSTRAINT "FarmAssignment_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmAssignment" ADD CONSTRAINT "FarmAssignment_dcoId_fkey" FOREIGN KEY ("dcoId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmAssignment" ADD CONSTRAINT "FarmAssignment_visitRequestId_fkey" FOREIGN KEY ("visitRequestId") REFERENCES "VisitRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FareRate" ADD CONSTRAINT "FareRate_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmVisit" ADD CONSTRAINT "FarmVisit_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmVisit" ADD CONSTRAINT "FarmVisit_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "FarmAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CropRecord" ADD CONSTRAINT "CropRecord_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmlandMeasurement" ADD CONSTRAINT "FarmlandMeasurement_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_cropRecordId_fkey" FOREIGN KEY ("cropRecordId") REFERENCES "CropRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelEvaluation" ADD CONSTRAINT "AiModelEvaluation_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "AiModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPrediction" ADD CONSTRAINT "AiPrediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPrediction" ADD CONSTRAINT "AiPrediction_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPrediction" ADD CONSTRAINT "AiPrediction_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "AiModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFeedback" ADD CONSTRAINT "AiFeedback_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "AiPrediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "Permission"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

