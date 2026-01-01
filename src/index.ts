import { buildServer } from './server.js';
import { loadThenGetEnvs } from '@mereb/shared-packages';
import { runMigrations } from './migrate.js';
import { createChildLogger } from './logger.js';
import { startHomeFeedWorker } from './homeFeedWorker.js';
import type { KafkaConfig } from 'kafkajs';

const {PORT, HOST, KAFKA_BROKERS} = loadThenGetEnvs({
    path: '/custom/.env',
    envs: [
        { key: 'PORT', type: 'number', fallback: 4002 },
        { key: 'HOST', type: 'string', fallback: '0.0.0.0' },
        { key: 'KAFKA_BROKERS', type: 'string', fallback: '' },
    ]
});

const logger = createChildLogger({ module: 'bootstrap' });
const kafkaConfig: KafkaConfig | null = KAFKA_BROKERS
    ? {
        clientId: 'svc-feed',
        brokers: KAFKA_BROKERS.split(',').map((broker) => broker.trim())
    }
    : null;

if (!kafkaConfig) {
    logger.warn('KAFKA_BROKERS not set; home feed worker disabled');
}

try {
    await runMigrations();

    if (kafkaConfig) {
        startHomeFeedWorker(kafkaConfig).catch((err) => {
            logger.error({err}, 'Failed to start home feed worker');
        });
    }

    const app = await buildServer();
    await app.listen({ port: PORT, host: HOST });
    logger.info({host: HOST, port: PORT}, 'Server listening');
} catch (err) {
    logger.error({err}, 'Failed to start server');
    process.exit(1);
}
