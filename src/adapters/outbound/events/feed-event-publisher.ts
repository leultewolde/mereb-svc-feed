import { randomUUID } from 'node:crypto';
import type { KafkaConfig } from 'kafkajs';
import { createChildLogger } from '../../../logger.js';
import type { FeedEventPublisherPort } from '../../../application/feed/ports.js';
import { emitPostCreated, emitPostLiked } from '../../../kafka.js';

const logger = createChildLogger({ module: 'feed-event-publisher' });

class NoopFeedEventPublisherAdapter implements FeedEventPublisherPort {
  async publishPostCreated(): Promise<void> {
    return;
  }

  async publishPostLiked(): Promise<void> {
    return;
  }
}

class KafkaFeedEventPublisherAdapter implements FeedEventPublisherPort {
  constructor(private readonly kafkaConfig: KafkaConfig) {}

  async publishPostCreated(input: {
    postId: string;
    authorId: string;
    createdAt: Date;
    visibility: string;
  }): Promise<void> {
    try {
      await emitPostCreated(this.kafkaConfig, {
        event_id: randomUUID(),
        event_type: 'post.created.v1',
        occurred_at: new Date().toISOString(),
        producer: 'svc-feed',
        data: {
          post_id: input.postId,
          author_id: input.authorId,
          created_at: input.createdAt.toISOString(),
          visibility: input.visibility
        }
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to emit post.created event');
    }
  }

  async publishPostLiked(input: {
    postId: string;
    userId: string;
  }): Promise<void> {
    try {
      await emitPostLiked(this.kafkaConfig, {
        event_id: randomUUID(),
        event_type: 'post.liked.v1',
        occurred_at: new Date().toISOString(),
        producer: 'svc-feed',
        postId: input.postId,
        userId: input.userId
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to emit post.liked event');
    }
  }
}

export function createFeedEventPublisherAdapter(
  kafkaConfig?: KafkaConfig | null
): FeedEventPublisherPort {
  if (!kafkaConfig) {
    return new NoopFeedEventPublisherAdapter();
  }
  return new KafkaFeedEventPublisherAdapter(kafkaConfig);
}

