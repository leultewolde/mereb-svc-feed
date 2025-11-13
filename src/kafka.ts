import { getProducer } from '@mereb/shared-packages';
import type { KafkaConfig } from 'kafkajs';

const DEFAULT_TOPIC_POST_CREATED = 'post.created.v1';
const DEFAULT_TOPIC_POST_LIKED = 'post.liked.v1';

export interface PostCreatedEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  producer: string;
  data: {
    post_id: string;
    author_id: string;
    created_at: string;
    visibility: string;
  };
}

export async function emitPostCreated(config: KafkaConfig, payload: PostCreatedEvent) {
  const producer = await getProducer(config);
  await producer.send({
    topic: DEFAULT_TOPIC_POST_CREATED,
    messages: [{ key: payload.data.post_id, value: JSON.stringify(payload) }]
  });
}

function getPostIdKey(payload: Record<string, unknown>): string {
    const raw = payload['postId'];
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        return String(raw);
    }
    try {
        return JSON.stringify(raw);
    } catch {
        return '';
    }
}

export async function emitPostLiked(
  config: KafkaConfig,
  payload: Record<string, unknown>
) {
  const producer = await getProducer(config);
  const key = getPostIdKey(payload);
  await producer.send({
    topic: DEFAULT_TOPIC_POST_LIKED,
    messages: [{ key, value: JSON.stringify(payload) }]
  });
}
