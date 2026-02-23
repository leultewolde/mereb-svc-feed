import { buildServer } from './server.js';
import { loadThenGetEnvs, buildKafkaConfigFromEnv, initDefaultTelemetry } from '@mereb/shared-packages';
import { runMigrations } from './migrate.js';
import { createChildLogger } from './logger.js';
import { startHomeFeedWorker } from './homeFeedWorker.js';

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

    if (kafkaConfig) {
        try {
            await startHomeFeedWorker(kafkaConfig);
        } catch (err) {
            logger.error({err}, 'Failed to start home feed worker');
        }
    }

    const app = await buildServer();
    await app.listen({ port: PORT, host: HOST });
    logger.info({host: HOST, port: PORT}, 'Server listening');
} catch (err) {
    logger.error({err}, 'Failed to start server');
    process.exit(1);
}
