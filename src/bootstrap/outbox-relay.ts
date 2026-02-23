import type { KafkaConfig } from 'kafkajs';
import { getProducer } from '@mereb/shared-packages';
import { createChildLogger } from '../logger.js';
import { PrismaFeedOutboxRelayStore } from '../adapters/outbound/prisma/feed-prisma-repository.js';

const logger = createChildLogger({ module: 'outbox-relay' });

function isRelayEnabled(): boolean {
  return (process.env.FEED_OUTBOX_RELAY_ENABLED ?? 'true') === 'true';
}

function getRelayIntervalMs(): number {
  const value = Number(process.env.FEED_OUTBOX_RELAY_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(value) || value < 250) {
    return 5000;
  }
  return Math.floor(value);
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1), 6);
  return Math.min(60_000, 1000 * (2 ** exponent));
}

async function flushOnce(kafkaConfig: KafkaConfig, limit = 50): Promise<void> {
  const store = new PrismaFeedOutboxRelayStore();
  const producer = await getProducer(kafkaConfig);
  const due = await store.listDue(limit);

  for (const event of due) {
    const claimed = await store.claim(event.id);
    if (!claimed) {
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
    } catch (error) {
      await store.markFailed(
        event.id,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        new Date(Date.now() + retryDelayMs(event.attempts + 1))
      );
      logger.warn({ err: error, outboxId: event.id, topic: event.topic }, 'Failed to publish feed outbox event');
    }
  }
}

export function startFeedOutboxRelay(kafkaConfig?: KafkaConfig | null): () => void {
  if (!kafkaConfig || !isRelayEnabled()) {
    return () => {};
  }

  const intervalMs = getRelayIntervalMs();
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
  timer.unref?.();
  logger.info({ intervalMs }, 'Feed outbox relay started');

  return () => clearInterval(timer);
}

