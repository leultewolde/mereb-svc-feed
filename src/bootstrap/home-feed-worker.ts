import type { Consumer, KafkaConfig } from 'kafkajs';
import {
  HomeFeedFanoutOnPostCreatedHandler,
  HomeFeedPostCreatedInboxHandler
} from '../application/feed/home-feed-fanout.js';
import { HomeFeedFanoutPrismaStoreAdapter } from '../adapters/outbound/prisma/home-feed-fanout-prisma-store.js';
import { startHomeFeedPostCreatedConsumer } from '../adapters/inbound/workers/home-feed-post-created-consumer.js';

export async function startHomeFeedWorker(
  kafkaConfig: KafkaConfig | null
): Promise<Consumer | null> {
  const store = new HomeFeedFanoutPrismaStoreAdapter();
  const fanout = new HomeFeedFanoutOnPostCreatedHandler(store);
  const inboxHandler = new HomeFeedPostCreatedInboxHandler(fanout, store);
  return startHomeFeedPostCreatedConsumer(kafkaConfig, inboxHandler);
}
