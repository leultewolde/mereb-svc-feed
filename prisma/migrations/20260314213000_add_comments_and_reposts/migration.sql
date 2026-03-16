ALTER TABLE "Post"
ADD COLUMN "repostOfId" TEXT;

ALTER TABLE "Post"
ADD CONSTRAINT "Post_repostOfId_fkey"
FOREIGN KEY ("repostOfId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Comment" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "authorId" VARCHAR(36) NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Comment"
ADD CONSTRAINT "Comment_postId_fkey"
FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Post_repostOfId_status_createdAt_id_idx"
ON "Post"("repostOfId", "status", "createdAt", "id");

CREATE INDEX "Comment_postId_createdAt_id_idx"
ON "Comment"("postId", "createdAt", "id");

CREATE INDEX "Comment_authorId_createdAt_id_idx"
ON "Comment"("authorId", "createdAt", "id");
