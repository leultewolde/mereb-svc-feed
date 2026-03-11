import { createConsumer, ensureTopicExists } from '@mereb/shared-packages';
import type { Consumer, KafkaConfig } from 'kafkajs';
import { createChildLogger } from '../../../logger.js';
import type {
  ProfileModerationInboxHandler,
  ProfileModerationIntegrationEvent
} from '../../../application/feed/profile-moderation-sync.js';
import { PROFILE_MODERATION_EVENT_TOPICS } from '../../../contracts/profile-events.js';

const logger = createChildLogger({ module: 'profile-moderation-worker' });

function getTopics(): string[] {
  return [
    process.env.KAFKA_TOPIC_PROFILE_USER_DEACTIVATED ?? PROFILE_MODERATION_EVENT_TOPICS.userDeactivated,
    process.env.KAFKA_TOPIC_PROFILE_USER_REACTIVATED ?? PROFILE_MODERATION_EVENT_TOPICS.userReactivated
  ];
}

function getConsumerGroupId() {
  return process.env.KAFKA_PROFILE_MODERATION_GROUP_ID ?? 'svc-feed-profile-moderation';
}

export async function startProfileModerationConsumer(
  kafkaConfig: KafkaConfig | null,
  handler: ProfileModerationInboxHandler
): Promise<Consumer | null> {
  if (!kafkaConfig) {
    logger.warn('Kafka config missing; profile moderation worker disabled');
    return null;
  }

  const topics = getTopics();
  for (const topic of topics) {
    await ensureTopicExists(kafkaConfig, topic, 1, 1);
  }

  const consumer = await createConsumer(kafkaConfig, getConsumerGroupId());
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  consumer
    .run({
      eachMessage: async ({ message, partition, topic }) => {
        const value = message.value?.toString();
        if (!value) {
          logger.warn({ topic, partition, offset: message.offset }, 'Skipping moderation message with no value');
          return;
        }

        let parsed: ProfileModerationIntegrationEvent | null = null;
        try {
          parsed = JSON.parse(value) as ProfileModerationIntegrationEvent;
        } catch (error) {
          logger.error({ err: error, value }, 'Failed to parse profile moderation event');
          return;
        }

        try {
          await handler.execute(parsed, {
            topic,
            partition,
            offset: message.offset,
            consumerGroup: getConsumerGroupId()
          });
        } catch (error) {
          logger.error(
            { err: error, topic, partition, offset: message.offset },
            'Failed to process profile moderation event'
          );
        }
      }
    })
    .catch((error) => {
      logger.error({ err: error }, 'Profile moderation consumer crashed');
    });

  logger.info({ topics, groupId: getConsumerGroupId() }, 'Profile moderation worker started');
  return consumer;
}

