import { startConsumer } from '@mereb/shared-packages';
import type { Consumer, KafkaConfig } from 'kafkajs';
import { createChildLogger } from '../../../logger.js';
import type {
  FeedPostCreatedIntegrationEvent,
  HomeFeedPostCreatedInboxHandler
} from '../../../application/feed/home-feed-fanout.js';

const logger = createChildLogger({ module: 'home-feed-worker' });

function getPostCreatedTopic() {
  return process.env.KAFKA_TOPIC_POST_CREATED ?? 'post.created.v1';
}

function getConsumerGroupId() {
  return process.env.KAFKA_HOME_FEED_GROUP_ID ?? 'svc-feed-home-feed';
}

export async function startHomeFeedPostCreatedConsumer(
  kafkaConfig: KafkaConfig | null,
  handler: HomeFeedPostCreatedInboxHandler
): Promise<Consumer | null> {
  return startConsumer<FeedPostCreatedIntegrationEvent>({
    kafkaConfig,
    topic: getPostCreatedTopic(),
    consumerGroup: getConsumerGroupId(),
    logger,
    parse: (raw) => JSON.parse(raw) as FeedPostCreatedIntegrationEvent,
    disabledMessage: 'Kafka config missing; home feed worker disabled',
    handle: async ({ topic, partition, offset, parsed, consumerGroup }) => {
      logger.info({ topic, partition, offset }, 'Received Kafka message');
      const result = await handler.execute(parsed, { topic, partition, offset, consumerGroup });
      if (result.status === 'skipped_missing_ids') {
        logger.warn({ event: parsed }, 'Received post.created event without ids');
      } else if (result.status === 'skipped_duplicate') {
        logger.info(
          { topic, partition, offset, eventId: parsed.event_id },
          'Skipping duplicate post.created event'
        );
      }
    }
  });
}
