import { buildServer } from './server.js';
import {
  loadThenGetEnvs,
  buildKafkaConfigFromEnv,
  getEnv,
  getRedisClient,
  initDefaultTelemetry
} from '@mereb/shared-packages';
import { runMigrations } from './migrate.js';
import { createChildLogger } from './logger.js';
import { startHomeFeedWorker } from './homeFeedWorker.js';
import { startProfileModerationWorker } from './profileModerationWorker.js';

const {PORT, HOST} = loadThenGetEnvs({
    envs: [
        { key: 'PORT', type: 'number', fallback: 4002 },
        { key: 'HOST', type: 'string', fallback: '0.0.0.0' },
        { key: 'KAFKA_BROKERS', type: 'string', fallback: '' },
    ]
});

const logger = createChildLogger({ module: 'bootstrap' });
initDefaultTelemetry('svc-feed');
const kafkaConfig = buildKafkaConfigFromEnv({
    clientId: 'svc-feed'
});

if (!kafkaConfig) {
    logger.warn('KAFKA_BROKERS not set; home feed worker disabled');
}

try {
    await runMigrations();

    let workerRedis;
    try {
        workerRedis = await getRedisClient({ url: getEnv('REDIS_URL') });
    } catch (err) {
        logger.warn({err}, 'Failed to connect Redis for feed workers; cache invalidation will be best-effort');
    }

    if (kafkaConfig) {
        try {
            await startHomeFeedWorker(kafkaConfig);
            await startProfileModerationWorker(kafkaConfig, workerRedis);
        } catch (err) {
            logger.error({err}, 'Failed to start feed workers');
        }
    }

    const app = await buildServer();
    await app.listen({ port: PORT, host: HOST });
    logger.info({host: HOST, port: PORT}, 'Server listening');
} catch (err) {
    logger.error({err}, 'Failed to start server');
    process.exit(1);
}
