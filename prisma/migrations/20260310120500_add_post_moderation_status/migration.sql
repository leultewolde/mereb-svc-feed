CREATE TYPE "PostStatus" AS ENUM ('ACTIVE', 'HIDDEN');
CREATE TYPE "PostHiddenReason" AS ENUM ('ADMIN_HIDDEN', 'USER_DEACTIVATED');

ALTER TABLE "Post"
ADD COLUMN "status" "PostStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "hiddenAt" TIMESTAMP(3),
ADD COLUMN "hiddenReason" "PostHiddenReason";

CREATE INDEX "Post_status_createdAt_id_idx"
ON "Post"("status", "createdAt", "id");

CREATE INDEX "Post_authorId_status_createdAt_id_idx"
ON "Post"("authorId", "status", "createdAt", "id");
