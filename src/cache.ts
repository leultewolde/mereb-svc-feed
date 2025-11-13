import type { RedisClientType } from '@redis/client';
import type { Post } from '../generated/client/index.js';

const POST_CACHE_PREFIX = 'post:';
const TTL_SECONDS = 120;

type CachedPost = Post & { createdAt: string | Date };

export async function getPostCache(redis: RedisClientType, postId: string): Promise<Post | null> {
  const cached = await redis.get(POST_CACHE_PREFIX + postId);
  if (!cached) {
    return null;
  }
  try {
    const parsed = JSON.parse(cached) as CachedPost;
    return {
      ...parsed,
      createdAt: new Date(parsed.createdAt)
    } as Post;
  } catch {
    await redis.del(POST_CACHE_PREFIX + postId);
    return null;
  }
}

export async function setPostCache(redis: RedisClientType, post: Post) {
  await redis.set(
    POST_CACHE_PREFIX + post.id,
    JSON.stringify({
      ...post,
      createdAt: post.createdAt.toISOString()
    }),
    {
      EX: TTL_SECONDS
    }
  );
}

export async function invalidatePostCache(redis: RedisClientType, postId: string) {
  await redis.del(POST_CACHE_PREFIX + postId);
}
