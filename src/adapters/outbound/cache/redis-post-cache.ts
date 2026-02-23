import type { RedisClientType } from '@redis/client';
import type { Prisma } from '../../../../generated/client/index.js';
import type { PostCachePort } from '../../../application/feed/ports.js';
import { getPostCache, invalidatePostCache, setPostCache } from '../../../cache.js';

export class RedisPostCacheAdapter implements PostCachePort {
  constructor(private readonly redis: RedisClientType | undefined) {}

  async get(postId: string) {
    return getPostCache(this.redis, postId);
  }

  async set(post: {
    id: string;
    authorId: string;
    body: string;
    media: unknown;
    visibility: string;
    createdAt: Date;
  }): Promise<void> {
    await setPostCache(this.redis, {
      ...post,
      media: post.media as Prisma.JsonValue
    });
  }

  async invalidate(postId: string): Promise<void> {
    await invalidatePostCache(this.redis, postId);
  }
}
