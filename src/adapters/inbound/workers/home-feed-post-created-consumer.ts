import { createConsumer, ensureTopicExists } from '@mereb/shared-packages';
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
  if (!kafkaConfig) {
    logger.warn('Kafka config missing; home feed worker disabled');
    return null;
  }

  const topic = getPostCreatedTopic();
  await ensureTopicExists(kafkaConfig, topic, 1, 1);
  const consumer = await createConsumer(kafkaConfig, getConsumerGroupId());
  await consumer.subscribe({ topic, fromBeginning: false });

  consumer
    .run({
      eachMessage: async ({ message, partition, topic }) => {
        logger.info(
          { topic, partition, offset: message.offset },
          'Received Kafka message'
        );

        const value = message.value?.toString();
        if (!value) {
          logger.warn(
            { topic, partition, offset: message.offset },
            'Skipping message with no value'
          );
          return;
        }

        let parsed: FeedPostCreatedIntegrationEvent | null = null;
        try {
          parsed = JSON.parse(value) as FeedPostCreatedIntegrationEvent;
        } catch (error) {
          logger.error({ err: error, value }, 'Failed to parse post.created message value');
          return;
        }

        try {
          const result = await handler.execute(parsed, {
            topic,
            partition,
            offset: message.offset,
            consumerGroup: getConsumerGroupId()
          });
          if (result.status === 'skipped_missing_ids') {
            logger.warn({ event: parsed }, 'Received post.created event without ids');
          } else if (result.status === 'skipped_duplicate') {
            logger.info(
              { topic, partition, offset: message.offset, eventId: parsed.event_id },
              'Skipping duplicate post.created event'
            );
          }
        } catch (error) {
          logger.error(
            { err: error, topic, partition, offset: message.offset },
            'Failed to fan out post.created event'
          );
        }
      }
    })
    .catch((error) => {
      logger.error({ err: error }, 'Home feed consumer crashed');
    });

  logger.info({ topic, groupId: getConsumerGroupId() }, 'Home feed worker started');
  return consumer;
}
