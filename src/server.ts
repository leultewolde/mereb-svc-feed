import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import rateLimit from '@fastify/rate-limit';
import mercurius from 'mercurius';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
  getEnv,
  getRedisClient,
  loadEnv,
  parseAuthHeader,
  verifyJwt
} from '@mereb/shared-packages';
import type { KafkaConfig } from 'kafkajs';
import { createResolvers } from './resolvers.js';
import type { GraphQLContext } from './context.js';

loadEnv();

const logger = createLogger('svc-feed');
const typeDefsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.graphql'
);
const typeDefs = readFileSync(typeDefsPath, 'utf8');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: logger as FastifyBaseLogger });

  await app.register(helmet);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });
  await app.register(underPressure);

  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  if (!issuer) {
    throw new Error('OIDC_ISSUER env var required');
  }

  const redisUrl = getEnv('REDIS_URL');
  const redis = await getRedisClient({ url: redisUrl });

  const kafkaBrokers = process.env.KAFKA_BROKERS;
  const kafkaConfig: KafkaConfig | null = kafkaBrokers
    ? {
        clientId: 'svc-feed',
        brokers: kafkaBrokers.split(',').map((broker) => broker.trim())
      }
    : null;

  app.addHook('onRequest', async (request) => {
    const token = parseAuthHeader(request.headers);
    if (!token) {
      request.userId = undefined;
      return;
    }
    try {
      const payload = await verifyJwt(token, { issuer, audience });
      request.userId = payload.sub;
    } catch (error) {
      request.log.debug({ err: error }, 'JWT verification failed');
      request.userId = undefined;
    }
  });

  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: createResolvers({ kafkaConfig })
  });

  await app.register(mercurius, {
    schema,
    graphiql: process.env.NODE_ENV !== 'production',
    federationMetadata: true,
    context: (request): GraphQLContext => ({ userId: request.userId, redis })
  });

  app.addHook('onRequest', (request, _, done) => {
    (request.log as unknown as { setBindings?: (bindings: Record<string, unknown>) => void }).setBindings?.({
      userId: request.userId
    });
    done();
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
