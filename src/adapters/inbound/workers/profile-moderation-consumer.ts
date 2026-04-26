import { startConsumer } from '@mereb/shared-packages';
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
  return startConsumer<ProfileModerationIntegrationEvent>({
    kafkaConfig,
    topic: getTopics(),
    consumerGroup: getConsumerGroupId(),
    logger,
    parse: (raw) => JSON.parse(raw) as ProfileModerationIntegrationEvent,
    disabledMessage: 'Kafka config missing; profile moderation worker disabled',
    handle: async ({ topic, partition, offset, parsed, consumerGroup }) => {
      await handler.execute(parsed, { topic, partition, offset, consumerGroup });
    }
  });
}
