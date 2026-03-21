const ENGAGEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIKE_BONUS_MS = 60_000;
const COMMENT_BONUS_MS = 120_000;
const REPOST_BONUS_MS = 180_000;

export interface HomeFeedScoreInput {
  createdAt: Date;
  likeCount: number;
  commentCount: number;
  repostCount: number;
  now?: Date;
}

export interface HomeFeedRankOrderInput {
  rank: bigint;
  insertedAt: Date;
  postId: string;
}

export function seedHomeFeedRank(createdAt: Date): bigint {
  return BigInt(createdAt.getTime());
}

export function computeHomeFeedRank(input: HomeFeedScoreInput): bigint {
  const baseScore = seedHomeFeedRank(input.createdAt);
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - input.createdAt.getTime();
  if (ageMs > ENGAGEMENT_WINDOW_MS) {
    return baseScore;
  }

  const likeBonus = BigInt(Math.min(input.likeCount, 10) * LIKE_BONUS_MS);
  const commentBonus = BigInt(Math.min(input.commentCount, 10) * COMMENT_BONUS_MS);
  const repostBonus = BigInt(Math.min(input.repostCount, 5) * REPOST_BONUS_MS);

  return baseScore + likeBonus + commentBonus + repostBonus;
}

export function compareHomeFeedRank(
  left: HomeFeedRankOrderInput,
  right: HomeFeedRankOrderInput
): number {
  if (left.rank !== right.rank) {
    return left.rank > right.rank ? -1 : 1;
  }
  if (left.insertedAt.getTime() !== right.insertedAt.getTime()) {
    return left.insertedAt > right.insertedAt ? -1 : 1;
  }
  if (left.postId === right.postId) {
    return 0;
  }
  return left.postId > right.postId ? -1 : 1;
}
