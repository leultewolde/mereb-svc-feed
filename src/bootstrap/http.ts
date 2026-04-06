import Fastify, { type FastifyInstance } from 'fastify';
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
import type { RedisClientType } from '@redis/client';
import type { KafkaConfig } from 'kafkajs';
import {
  createFastifyLoggerOptions,
  extractJwtRoles,
  getEnv,
  getRedisClient,
  loadEnv,
  parseAuthHeader,
  verifyJwt
} from '@mereb/shared-packages';
import type { GraphQLContext } from '../context.js';
import { createResolvers } from '../adapters/inbound/graphql/resolvers.js';
import { createContainer } from './container.js';

loadEnv();

const typeDefsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema.graphql');
const typeDefs = readFileSync(typeDefsPath, 'utf8');

function parseIssuerEnv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function verifyJwtWithIssuerFallback(
  token: string,
  options: { issuer: string; audience?: string }
) {
  const issuers = parseIssuerEnv(options.issuer);
  let lastError: unknown;

  for (const issuer of issuers) {
    try {
      return await verifyJwt(token, { issuer, audience: options.audience });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('OIDC_ISSUER env var required');
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createFastifyLoggerOptions('svc-feed')
  });

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
  let redis: RedisClientType | undefined;
  try {
    redis = await getRedisClient({ url: redisUrl });
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to connect to Redis, cache disabled');
  }

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
      request.roles = [];
      return;
    }
    try {
      const payload = await verifyJwtWithIssuerFallback(token, { issuer, audience });
      request.userId = payload.sub;
      request.roles = extractJwtRoles(payload);
    } catch (error) {
      request.log.debug({ err: error }, 'JWT verification failed');
      request.userId = undefined;
      request.roles = [];
    }
  });

  const container = createContainer({ redis, kafkaConfig });
  const schema = makeExecutableSchema<GraphQLContext>({
    typeDefs,
    resolvers: createResolvers(container.feed)
  });

  await app.register(mercurius, {
    schema,
    graphiql: process.env.NODE_ENV !== 'production',
    federationMetadata: true,
    context: (request): GraphQLContext => ({ userId: request.userId, roles: request.roles ?? [], redis })
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
