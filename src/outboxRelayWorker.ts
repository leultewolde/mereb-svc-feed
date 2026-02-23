import {
  buildKafkaConfigFromEnv,
  initDefaultTelemetry,
  loadThenGetEnvs
} from '@mereb/shared-packages';
import { createChildLogger } from './logger.js';
import { runMigrations } from './migrate.js';
import { startFeedOutboxRelay } from './bootstrap/outbox-relay.js';

loadThenGetEnvs({
  envs: [
    { key: 'KAFKA_BROKERS', type: 'string', fallback: '' }
  ]
});

initDefaultTelemetry('svc-feed-outbox-relay');
const logger = createChildLogger({ module: 'outbox-relay-worker' });

function waitForShutdown(stop: () => void): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const handleSignal = (signal: NodeJS.Signals) => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.info({ signal }, 'Shutting down feed outbox relay worker');
      stop();
      resolve();
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  });
}

if ((process.env.FEED_OUTBOX_RELAY_ENABLED ?? 'true') !== 'true') {
  logger.error('FEED_OUTBOX_RELAY_ENABLED=false; dedicated outbox relay worker will not start');
  process.exit(1);
}

const kafkaConfig = buildKafkaConfigFromEnv({ clientId: 'svc-feed-outbox-relay' });
if (!kafkaConfig) {
  logger.error('KAFKA_BROKERS not set; cannot start feed outbox relay worker');
  process.exit(1);
}

try {
  await runMigrations();
  const stop = startFeedOutboxRelay(kafkaConfig, { unrefTimer: false });
  logger.info('Feed outbox relay worker started');
  await waitForShutdown(stop);
} catch (error) {
  logger.error({ err: error }, 'Failed to start feed outbox relay worker');
  process.exit(1);
}

