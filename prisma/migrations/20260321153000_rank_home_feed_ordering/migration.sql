ALTER TABLE "HomeFeed"
ALTER COLUMN "rank" TYPE BIGINT
USING "rank"::BIGINT;

UPDATE "HomeFeed"
SET "rank" = FLOOR(EXTRACT(EPOCH FROM "insertedAt") * 1000)::BIGINT;

DROP INDEX IF EXISTS "HomeFeed_ownerId_insertedAt_postId_idx";

CREATE INDEX "HomeFeed_ownerId_rank_insertedAt_postId_idx"
ON "HomeFeed"("ownerId", "rank", "insertedAt", "postId");
