import { test } from 'vitest';
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

test('feedHome delegates to the query layer with execution context', async () => {
  let receivedArgs: { after?: string; limit?: number } | null = null;
  let receivedCtx: unknown = null;
  const feed = createFeedModuleStub();
  feed.queries.feedHome = async (args, ctx) => {
    receivedArgs = args;
    receivedCtx = ctx;
    return { edges: [], pageInfo: { endCursor: null, hasNextPage: false } };
  };

  const resolvers = createResolvers(feed);
  const feedHome = (resolvers.Query as Record<string, unknown>).feedHome as (
    source: unknown,
    args: { after?: string; limit?: number },
    ctx: { userId?: string }
  ) => Promise<unknown>;

  await feedHome({}, { after: 'cursor-1', limit: 10 }, { userId: 'user-1' });

  assert.deepEqual(receivedArgs, { after: 'cursor-1', limit: 10 });
  assert.deepEqual(receivedCtx, { principal: { userId: 'user-1' } });
});

test('entity resolver delegates user and post references', async () => {
  const calls: Array<{ kind: string; id: string }> = [];
  const feed = createFeedModuleStub();
  feed.queries.resolveUserReference = (id: string) => {
    calls.push({ kind: 'user', id });
    return { id };
  };
  feed.queries.resolvePostReference = async (id: string) => {
    calls.push({ kind: 'post', id });
    return {
      id,
      authorId: 'user-1',
      body: 'hello',
      media: [],
      createdAt: '2026-02-01T00:00:00.000Z',
      visibility: 'public',
      likeCount: 0,
      likedByMe: false,
      author: { id: 'user-1' }
    };
  };

  const resolvers = createResolvers(feed);
  const entities = (resolvers.Query as Record<string, unknown>)._entities as (
    source: unknown,
    args: { representations: Array<{ __typename?: string; id?: string }> },
    ctx: { userId?: string }
  ) => Promise<Array<unknown>>;

  const result = await entities(
    {},
    {
      representations: [
        { __typename: 'User', id: 'user-1' },
        { __typename: 'Post', id: 'post-1' }
      ]
    },
    { userId: 'viewer-1' }
  );

  assert.deepEqual(calls, [
    { kind: 'user', id: 'user-1' },
    { kind: 'post', id: 'post-1' }
  ]);
  assert.equal(result.length, 2);
});

test('post and user field resolvers reuse resolved values before delegating', async () => {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const feed = createFeedModuleStub();
  feed.queries.userPosts = async (userId, args, ctx) => {
    calls.push({ kind: 'userPosts', payload: { userId, args, ctx } });
    return { edges: [], pageInfo: { endCursor: null, hasNextPage: false } };
  };
  feed.queries.userLikedPost = async (postId, ctx) => {
    calls.push({ kind: 'userLikedPost', payload: { postId, ctx } });
    return true;
  };
  feed.queries.postMedia = async (post) => {
    calls.push({ kind: 'postMedia', payload: post });
    return [{ type: 'image', url: 'signed:image.jpg' }];
  };
  feed.queries.postLikeCount = async (postId) => {
    calls.push({ kind: 'postLikeCount', payload: postId });
    return 5;
  };
  feed.queries.postLikedByViewer = async (postId, ctx) => {
    calls.push({ kind: 'postLikedByViewer', payload: { postId, ctx } });
    return false;
  };

  const resolvers = createResolvers(feed);
  const entity = resolvers._Entity as Record<string, (value: unknown) => string | null>;
  const user = resolvers.User as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const post = resolvers.Post as Record<string, (...args: unknown[]) => Promise<unknown> | unknown>;

  assert.equal(entity.__resolveType({ body: 'hello' }), 'Post');
  assert.equal(entity.__resolveType({ id: 'user-1' }), 'User');
  assert.equal(entity.__resolveType({}), null);

  await user.posts({ id: 'user-1' }, { after: 'cursor', limit: 3 }, { userId: 'viewer-1' });
  await user.liked({ id: 'user-1' }, { postId: 'post-1' }, { userId: 'viewer-1' });
  assert.deepEqual(post.author({ author: { id: 'author-1' } }), { id: 'author-1' });
  assert.deepEqual(post.author({ authorId: 'author-2' }), { __typename: 'User', id: 'author-2' });
  assert.deepEqual(
    await post.media({ media: [{ type: 'image', url: 'resolved.jpg' }] }),
    [{ type: 'image', url: 'resolved.jpg' }]
  );
  assert.deepEqual(
    await post.media({ media: [{ type: 'image', key: 'image.jpg' }] }),
    [{ type: 'image', url: 'signed:image.jpg' }]
  );
  assert.equal(post.likeCount({ likeCount: 8 }), 8);
  assert.equal(await post.likeCount({ id: 'post-1' }), 5);
  assert.equal(await post.likedByMe({ likedByMe: true }, {}, {}), true);
  assert.equal(await post.likedByMe({ id: 'post-2' }, {}, { userId: 'viewer-1' }), false);

  assert.deepEqual(calls, [
    {
      kind: 'userPosts',
      payload: {
        userId: 'user-1',
        args: { after: 'cursor', limit: 3 },
        ctx: { principal: { userId: 'viewer-1' } }
      }
    },
    {
      kind: 'userLikedPost',
      payload: { postId: 'post-1', ctx: { principal: { userId: 'viewer-1' } } }
    },
    { kind: 'postMedia', payload: { media: [{ type: 'image', key: 'image.jpg' }] } },
    { kind: 'postLikeCount', payload: 'post-1' },
    {
      kind: 'postLikedByViewer',
      payload: { postId: 'post-2', ctx: { principal: { userId: 'viewer-1' } } }
    }
  ]);
});

test('feed resolvers cover query shortcuts, references, and mutation mappings', async () => {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const feed = createFeedModuleStub();
  feed.queries.post = async (id, ctx) => {
    calls.push({ kind: 'post', payload: { id, ctx } });
    return null;
  };
  feed.queries.adminContentMetrics = async () => {
    calls.push({ kind: 'adminContentMetrics', payload: null });
    return { totalPosts: 1, postsLast24h: 1, totalLikes: 1 };
  };
  feed.queries.adminRecentPosts = async (args, ctx) => {
    calls.push({ kind: 'adminRecentPosts', payload: { args, ctx } });
    return [];
  };
  feed.queries.resolvePostReference = async (id, ctx) => {
    calls.push({ kind: 'resolvePostReference', payload: { id, ctx } });
    return null;
  };
  feed.queries.resolveUserReference = (id: string) => {
    calls.push({ kind: 'resolveUserReference', payload: id });
    return { id };
  };
  feed.mutations.likePost = async (input, ctx) => {
    calls.push({ kind: 'likePost', payload: { input, ctx } });
    throw new UnauthenticatedError();
  };
  feed.mutations.unlikePost = async (input, ctx) => {
    calls.push({ kind: 'unlikePost', payload: { input, ctx } });
    return true;
  };

  const resolvers = createResolvers(feed);
  const query = resolvers.Query as Record<string, (...args: unknown[]) => Promise<unknown> | unknown>;
  const mutation = resolvers.Mutation as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const user = resolvers.User as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const post = resolvers.Post as Record<string, (...args: unknown[]) => Promise<unknown>>;

  await query.post({}, { id: 'post-1' }, { userId: 'viewer-1' });
  await query.adminContentMetrics({}, {}, {});
  await query.adminRecentPosts({}, { limit: 4 }, { userId: 'viewer-1' });
  assert.deepEqual(query._service({}, {}, {}), { sdl: null });
  await user.__resolveReference({ id: 'user-2' });
  await post.__resolveReference({ id: 'post-2' }, {}, { userId: 'viewer-1' });

  await assert.rejects(
    () => mutation.likePost({}, { id: 'post-1' }, {}),
    (error: unknown) =>
      error instanceof Error && error.message === 'UNAUTHENTICATED'
  );

  assert.equal(await mutation.unlikePost({}, { id: 'post-2' }, { userId: 'viewer-1' }), true);
  assert.deepEqual(calls, [
    { kind: 'post', payload: { id: 'post-1', ctx: { principal: { userId: 'viewer-1' } } } },
    { kind: 'adminContentMetrics', payload: null },
    {
      kind: 'adminRecentPosts',
      payload: { args: { limit: 4 }, ctx: { principal: { userId: 'viewer-1' } } }
    },
    { kind: 'resolveUserReference', payload: 'user-2' },
    {
      kind: 'resolvePostReference',
      payload: { id: 'post-2', ctx: { principal: { userId: 'viewer-1' } } }
    },
    { kind: 'likePost', payload: { input: { id: 'post-1' }, ctx: {} } },
    {
      kind: 'unlikePost',
      payload: { input: { id: 'post-2' }, ctx: { principal: { userId: 'viewer-1' } } }
    }
  ]);
});
