import type { RedisClientType } from '@redis/client';
import type { KafkaConfig } from 'kafkajs';
import {
  createFeedApplicationModule,
  type FeedApplicationModule
} from '../application/feed/use-cases.js';
import {
  PrismaFeedOutboxEventPublisher,
  PrismaFeedRepository,
  PrismaFeedTransactionRunner
} from '../adapters/outbound/prisma/feed-prisma-repository.js';
import { RedisPostCacheAdapter } from '../adapters/outbound/cache/redis-post-cache.js';
import { SharedMediaUrlSignerAdapter } from '../adapters/outbound/media/shared-media-url-signer.js';
import { createFeedEventPublisherAdapter } from '../adapters/outbound/events/feed-event-publisher.js';

export interface FeedContainer {
  feed: FeedApplicationModule;
}

export function createContainer(input: {
  redis?: RedisClientType;
  kafkaConfig?: KafkaConfig | null;
}): FeedContainer {
  const repository = new PrismaFeedRepository();
  const postCache = new RedisPostCacheAdapter(input.redis);
  const mediaUrlSigner = new SharedMediaUrlSignerAdapter();
  const useOutbox = Boolean(input.kafkaConfig);
  const eventPublisher = useOutbox
    ? new PrismaFeedOutboxEventPublisher()
    : createFeedEventPublisherAdapter(input.kafkaConfig);
  const transactionRunner = useOutbox ? new PrismaFeedTransactionRunner() : undefined;

  return {
    feed: createFeedApplicationModule({
      repository,
      postCache,
      mediaUrlSigner,
      eventPublisher,
      transactionRunner
    })
  };
}
