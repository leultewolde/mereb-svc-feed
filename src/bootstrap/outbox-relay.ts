import type { KafkaConfig } from 'kafkajs';
import {
  flushOutboxOnce,
  getProducer,
  readOutboxEnvConfig,
  startOutboxRelay,
  type OutboxRelayMetrics,
  type OutboxRelayPublisher
} from '@mereb/shared-packages';
import { createChildLogger } from '../logger.js';
import {
  PrismaFeedOutboxRelayStore,
  type PendingFeedOutboxEvent
} from '../adapters/outbound/prisma/feed-prisma-repository.js';
import { recordFeedOutboxFlushMetrics, setFeedOutboxQueueDepth } from './outbox-metrics.js';

const logger = createChildLogger({ module: 'outbox-relay' });

export interface FeedOutboxRelayStartOptions {
  unrefTimer?: boolean;
  intervalMs?: number;
}

export interface FeedOutboxFlushOptions {
  kafkaConfig: KafkaConfig;
  limit?: number;
  store?: PrismaFeedOutboxRelayStore;
}

function resolveDlqTopic(topic: string): string {
  return process.env.FEED_OUTBOX_DLQ_TOPIC ?? `${topic}.dlq`;
}

function buildPublisher(
  kafkaConfig: KafkaConfig,
  dlqEnabled: boolean
): OutboxRelayPublisher<PendingFeedOutboxEvent> {
  return {
    async publish(event) {
      const producer = await getProducer(kafkaConfig);
      await producer.send({
        topic: event.topic,
        messages: [
          {
            key: event.eventKey ?? undefined,
            value: JSON.stringify(event.payload)
          }
        ]
      });
    },
    async publishDeadLetter(event, error) {
      if (!dlqEnabled) {
        return { deadLetterTopic: null };
      }
      const producer = await getProducer(kafkaConfig);
      const dlqTopic = resolveDlqTopic(event.topic);
      await producer.send({
        topic: dlqTopic,
        messages: [
          {
            key: event.eventKey ?? event.id,
            value: JSON.stringify({
              outbox_id: event.id,
              original_topic: event.topic,
              original_event_key: event.eventKey,
              attempts: error.attempts,
              error: error.message,
              failed_at: new Date().toISOString(),
              payload: event.payload
            })
          }
        ]
      });
      return { deadLetterTopic: dlqTopic };
    }
  };
}

const metrics: OutboxRelayMetrics = {
  refreshQueueDepth: (counts) => setFeedOutboxQueueDepth(counts),
  recordFlush: (summary) => recordFeedOutboxFlushMetrics(summary)
};

export async function flushFeedOutboxOnce(input: FeedOutboxFlushOptions): Promise<void> {
  const config = readOutboxEnvConfig({ prefix: 'FEED' });
  const store = input.store ?? new PrismaFeedOutboxRelayStore();
  const publisher = buildPublisher(input.kafkaConfig, config.dlqEnabled);
  await flushOutboxOnce({
    config: { ...config, batchSize: input.limit ?? 50 },
    store,
    publisher,
    logger,
    metrics
  });
}

export function startFeedOutboxRelay(
  kafkaConfig?: KafkaConfig | null,
  options: FeedOutboxRelayStartOptions = {}
): () => void {
  const config = readOutboxEnvConfig({ prefix: 'FEED' });
  if (!kafkaConfig || !config.enabled) {
    return () => {};
  }
  const publisher = buildPublisher(kafkaConfig, config.dlqEnabled);
  return startOutboxRelay({
    config: {
      ...config,
      intervalMs: options.intervalMs ?? config.intervalMs
    },
    store: new PrismaFeedOutboxRelayStore(),
    publisher,
    logger,
    metrics,
    options: { unrefTimer: options.unrefTimer }
  });
}
