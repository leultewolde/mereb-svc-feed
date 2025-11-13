-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "authorId" VARCHAR(36) NOT NULL,
    "body" TEXT NOT NULL,
    "media" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Like" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Like_pkey" PRIMARY KEY ("userId","postId")
);

-- CreateTable
CREATE TABLE "HomeFeed" (
    "ownerId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "insertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HomeFeed_pkey" PRIMARY KEY ("ownerId","postId")
);

-- CreateIndex
CREATE INDEX "Post_createdAt_id_idx" ON "Post"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Like_postId_createdAt_idx" ON "Like"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "HomeFeed_ownerId_insertedAt_postId_idx" ON "HomeFeed"("ownerId", "insertedAt", "postId");

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
