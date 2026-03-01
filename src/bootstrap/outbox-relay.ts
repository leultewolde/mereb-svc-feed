import type { KafkaConfig } from 'kafkajs';
import { getProducer } from '@mereb/shared-packages';
import { createChildLogger } from '../logger.js';
import { PrismaFeedOutboxRelayStore } from '../adapters/outbound/prisma/feed-prisma-repository.js';
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

function isRelayEnabled(): boolean {
  return (process.env.FEED_OUTBOX_RELAY_ENABLED ?? 'true') === 'true';
}

function isDlqEnabled(): boolean {
  return (process.env.FEED_OUTBOX_DLQ_ENABLED ?? 'false') === 'true';
}

function getRelayIntervalMs(fallback?: number): number {
  const value = fallback ?? Number(process.env.FEED_OUTBOX_RELAY_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(value) || value < 250) {
    return 5000;
  }
  return Math.floor(value);
}

function getMaxAttempts(): number {
  const value = Number(process.env.FEED_OUTBOX_MAX_ATTEMPTS ?? 10);
  if (!Number.isFinite(value) || value < 1) {
    return 10;
  }
  return Math.floor(value);
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1), 6);
  return Math.min(60_000, 1000 * (2 ** exponent));
}

function resolveDlqTopic(topic: string): string {
  return process.env.FEED_OUTBOX_DLQ_TOPIC ?? `${topic}.dlq`;
}

async function updateQueueDepthMetrics(store: PrismaFeedOutboxRelayStore): Promise<void> {
  try {
    const counts = await store.countByStatus();
    setFeedOutboxQueueDepth(counts);
  } catch (error) {
    logger.warn({ err: error }, 'Failed to refresh feed outbox queue depth metrics');
  }
}

async function publishToDlq(
  kafkaConfig: KafkaConfig,
  event: {
    id: string;
    topic: string;
    eventKey: string | null;
    payload: Record<string, unknown>;
    attempts: number;
  },
  errorMessage: string
): Promise<string> {
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
          attempts: event.attempts,
          error: errorMessage,
          failed_at: new Date().toISOString(),
          payload: event.payload
        })
      }
    ]
  });
  return dlqTopic;
}

async function flushOnce(
  kafkaConfig: KafkaConfig,
  limit = 50,
  store = new PrismaFeedOutboxRelayStore()
): Promise<void> {
  const producer = await getProducer(kafkaConfig);
  const due = await store.listDue(limit);
  const maxAttempts = getMaxAttempts();

  if (due.length === 0) {
    await updateQueueDepthMetrics(store);
    return;
  }

  let publishedCount = 0;
  let retryScheduledCount = 0;
  let terminalFailureCount = 0;
  let skippedCount = 0;

  for (const event of due) {
    const claimed = await store.claim(event.id);
    if (!claimed) {
      skippedCount += 1;
      continue;
    }

    try {
      await producer.send({
        topic: event.topic,
        messages: [
          {
            key: event.eventKey ?? undefined,
            value: JSON.stringify(event.payload)
          }
        ]
      });
      await store.markPublished(event.id);
      publishedCount += 1;
    } catch (error) {
      const attempt = event.attempts + 1;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const shouldStopRetrying = attempt >= maxAttempts;

      if (shouldStopRetrying) {
        let deadLetterTopic: string | null = null;

        if (isDlqEnabled()) {
          try {
            deadLetterTopic = await publishToDlq(
              kafkaConfig,
              { ...event, attempts: attempt },
              message
            );
          } catch (dlqError) {
            logger.error(
              { err: dlqError, outboxId: event.id, topic: event.topic, attempts: attempt },
              'Failed to publish feed outbox event to DLQ'
            );
            deadLetterTopic = null;
          }
        }

        terminalFailureCount += 1;
        await store.markDeadLetter(
          event.id,
          `[DEAD_LETTER after ${attempt} attempts] ${message}`,
          { deadLetteredAt: new Date(), deadLetterTopic }
        );
        logger.error(
          {
            err: error,
            outboxId: event.id,
            topic: event.topic,
            attempts: attempt,
            maxAttempts,
            deadLetterTopic
          },
          'Feed outbox event reached max attempts and was moved to DEAD_LETTER'
        );
      } else {
        retryScheduledCount += 1;
        await store.markFailed(
          event.id,
          message,
          new Date(Date.now() + retryDelayMs(attempt))
        );
        logger.warn(
          { err: error, outboxId: event.id, topic: event.topic, attempts: attempt, maxAttempts },
          'Failed to publish feed outbox event; retry scheduled'
        );
      }
    }
  }

  await updateQueueDepthMetrics(store);
  recordFeedOutboxFlushMetrics({
    batchSize: due.length,
    publishedCount,
    retryScheduledCount,
    terminalFailureCount,
    skippedCount
  });

  logger.info(
    {
      batchSize: due.length,
      publishedCount,
      retryScheduledCount,
      terminalFailureCount,
      skippedCount,
      maxAttempts
    },
    'Feed outbox relay flush completed'
  );
}

export function startFeedOutboxRelay(
  kafkaConfig?: KafkaConfig | null,
  options: FeedOutboxRelayStartOptions = {}
): () => void {
  if (!kafkaConfig || !isRelayEnabled()) {
    return () => {};
  }

  const intervalMs = getRelayIntervalMs(options.intervalMs);
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await flushOnce(kafkaConfig);
    } catch (error) {
      logger.error({ err: error }, 'Unexpected error in feed outbox relay');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  if (options.unrefTimer !== false) {
    timer.unref?.();
  }
  logger.info({ intervalMs }, 'Feed outbox relay started');

  return () => clearInterval(timer);
}

export async function flushFeedOutboxOnce(
  input: FeedOutboxFlushOptions
): Promise<void> {
  await flushOnce(input.kafkaConfig, input.limit ?? 50, input.store);
}
