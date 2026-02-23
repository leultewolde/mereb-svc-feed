import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolvers } from '../src/adapters/inbound/graphql/resolvers.js';
import { UnauthenticatedError } from '../src/domain/feed/errors.js';
import type { FeedApplicationModule } from '../src/application/feed/use-cases.js';

function createFeedModuleStub(): FeedApplicationModule {
  return {
    queries: {
      async post() { return null; },
      async resolvePostReference() { return null; },
      resolveUserReference(id: string) { return { id }; },
      async userPosts() { return { edges: [], pageInfo: { endCursor: null, hasNextPage: false } }; },
      async userLikedPost() { return false; },
      async adminContentMetrics() { return { totalPosts: 0, postsLast24h: 0, totalLikes: 0 }; },
      async adminRecentPosts() { return []; },
      async feedHome() { return { edges: [], pageInfo: { endCursor: null, hasNextPage: false } }; },
      async postLikeCount() { return 0; },
      async postLikedByViewer() { return false; },
      async postMedia() { return []; }
    },
    mutations: {
      async createPost() { throw new UnauthenticatedError(); },
      async likePost() { return true; },
      async unlikePost() { return true; }
    },
    helpers: {
      toExecutionContext(ctx: { userId?: string }) {
        return ctx.userId ? { principal: { userId: ctx.userId } } : {};
      }
    }
  };
}

test('createPost mutation maps UnauthenticatedError to GraphQL error message', async () => {
  const resolvers = createResolvers(createFeedModuleStub());
  const createPost = (resolvers.Mutation as Record<string, unknown>).createPost as (
    source: unknown,
    args: { body: string; mediaKeys?: string[] },
    ctx: { userId?: string }
  ) => Promise<unknown>;

  await assert.rejects(
    () => createPost({}, { body: 'hello' }, {}),
    (error: unknown) =>
      error instanceof Error && error.message === 'UNAUTHENTICATED'
  );
});

