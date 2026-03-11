import { Prisma } from '../../../../generated/client/index.js';
import { prisma } from '../../../prisma.js';
import { createChildLogger } from '../../../logger.js';
import type {
  ProfileModerationInboxStorePort,
  ProfileModerationStorePort
} from '../../../application/feed/profile-moderation-sync.js';
import { PrismaFeedRepository } from './feed-prisma-repository.js';
import { RedisPostCacheAdapter } from '../cache/redis-post-cache.js';
import type { RedisClientType } from '@redis/client';

const logger = createChildLogger({ module: 'profile-moderation-prisma-store' });

export class ProfileModerationPrismaStoreAdapter
  implements ProfileModerationStorePort, ProfileModerationInboxStorePort
{
  private readonly repository = new PrismaFeedRepository();
  private readonly postCache: RedisPostCacheAdapter;

  constructor(redis?: RedisClientType) {
    this.postCache = new RedisPostCacheAdapter(redis);
  }

  async hideAuthorPosts(authorId: string): Promise<string[]> {
    return this.repository.updateAdminPostsForAuthor({
      authorId,
      status: 'HIDDEN',
      hiddenReason: 'USER_DEACTIVATED'
    });
  }

  async restoreAuthorPosts(authorId: string): Promise<string[]> {
    return this.repository.restoreAuthorPostsHiddenByDeactivation(authorId);
  }

  async invalidatePostCache(postId: string): Promise<void> {
    await this.postCache.invalidate(postId);
  }

  async claimInboxEvent(input: {
    consumerGroup: string;
    topic: string;
    partition: number;
    offset: string;
    eventId?: string;
    eventKey: string;
  }): Promise<boolean> {
    try {
      await prisma.inboxEvent.create({
        data: {
          consumerGroup: input.consumerGroup,
          topic: input.topic,
          partition: input.partition,
          offset: input.offset,
          eventId: input.eventId,
          eventKey: input.eventKey,
          status: 'PROCESSING'
        }
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  async markInboxEventProcessed(input: {
    consumerGroup: string;
    eventKey: string;
  }): Promise<void> {
    await prisma.inboxEvent.update({
      where: {
        consumerGroup_eventKey: {
          consumerGroup: input.consumerGroup,
          eventKey: input.eventKey
        }
      },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        lastError: null
      }
    });
  }

  async markInboxEventFailed(input: {
    consumerGroup: string;
    eventKey: string;
    errorMessage: string;
  }): Promise<void> {
    await prisma.inboxEvent
      .update({
        where: {
          consumerGroup_eventKey: {
            consumerGroup: input.consumerGroup,
            eventKey: input.eventKey
          }
        },
        data: {
          status: 'FAILED',
          lastError: input.errorMessage
        }
      })
      .catch((error) => {
        logger.error(
          { err: error, consumerGroup: input.consumerGroup, eventKey: input.eventKey },
          'Failed to mark moderation inbox event as failed'
        );
      });
  }
}

