import type { RedisClientType } from '@redis/client';

export interface GraphQLContext {
  userId?: string;
  redis?: RedisClientType;
}
