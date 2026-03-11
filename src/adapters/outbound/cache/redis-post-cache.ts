import type { RedisClientType } from '@redis/client';
import type { Prisma } from '../../../../generated/client/index.js';
import type { FeedPostRecord, PostCachePort } from '../../../application/feed/ports.js';
import { getPostCache, invalidatePostCache, setPostCache } from '../../../cache.js';

export class RedisPostCacheAdapter implements PostCachePort {
  constructor(private readonly redis: RedisClientType | undefined) {}

  async get(postId: string): Promise<FeedPostRecord | null> {
    return (await getPostCache(this.redis, postId)) as FeedPostRecord | null;
  }

  async set(post: FeedPostRecord): Promise<void> {
    await setPostCache(this.redis, {
      ...post,
      media: post.media as Prisma.JsonValue
    });
  }

  async invalidate(postId: string): Promise<void> {
    await invalidatePostCache(this.redis, postId);
  }
}
