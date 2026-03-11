import type { Consumer, KafkaConfig } from 'kafkajs';
import type { RedisClientType } from '@redis/client';
import {
  ProfileModerationInboxHandler,
  ProfileModerationSyncHandler
} from '../application/feed/profile-moderation-sync.js';
import { startProfileModerationConsumer } from '../adapters/inbound/workers/profile-moderation-consumer.js';
import { ProfileModerationPrismaStoreAdapter } from '../adapters/outbound/prisma/profile-moderation-prisma-store.js';

export async function startProfileModerationWorker(
  kafkaConfig: KafkaConfig | null,
  redis?: RedisClientType
): Promise<Consumer | null> {
  const store = new ProfileModerationPrismaStoreAdapter(redis);
  const moderation = new ProfileModerationSyncHandler(store);
  const inboxHandler = new ProfileModerationInboxHandler(moderation, store);
  return startProfileModerationConsumer(kafkaConfig, inboxHandler);
}

