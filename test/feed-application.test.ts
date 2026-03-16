import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createFeedApplicationModule
} from '../src/application/feed/use-cases.js';
import type {
  FeedCommentRecord,
  FeedEventPublisherPort,
  FeedPostRecord,
  FeedRepositoryPort,
  MediaUrlSignerPort,
  PostCachePort
} from '../src/application/feed/ports.js';
import { UnauthenticatedError } from '../src/domain/feed/errors.js';

function postRecord(overrides: Partial<FeedPostRecord> = {}): FeedPostRecord {
  return {
    id: 'post-1',
    authorId: 'user-1',
    body: 'Hello',
    media: [],
    visibility: 'public',
    status: 'ACTIVE',
    hiddenAt: null,
    hiddenReason: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides
  };
}

function createRepositoryStub(overrides: Partial<FeedRepositoryPort> = {}): FeedRepositoryPort {
  return {
    async findPostById() {
      return null;
    },
    async findAdminPostById() {
      return null;
    },
    async listPostsByAuthor() {
      return [];
    },
    async listRecentPosts() {
      return [];
    },
    async listAdminPosts() {
      return [];
    },
    async listHomeFeed() {
      return [];
    },
    async createPost() {
      return postRecord();
    },
    async upsertHomeFeedEntry() {
      return;
    },
    async countPosts() {
      return 0;
    },
    async countPostsCreatedSince() {
      return 0;
    },
    async updateAdminPostStatus() {
      return null;
    },
    async updateAdminPostsForAuthor() {
      return [];
    },
    async restoreAuthorPostsHiddenByDeactivation() {
      return [];
    },
    async countLikes() {
      return 0;
    },
    async countLikesForPost() {
      return 0;
    },
    async countCommentsForPost() {
      return 0;
    },
    async countRepostsForPost() {
      return 0;
    },
    async isLikedByUser() {
      return false;
    },
    async upsertLike() {
      return;
    },
    async deleteLikeIfExists() {
      return;
    },
    async findCommentById(): Promise<FeedCommentRecord | null> {
      return null;
    },
    async listCommentsByPost() {
      return [];
    },
    async createComment() {
      throw new Error('not implemented');
    },
    async deleteCommentIfAuthor() {
      return false;
    },
    ...overrides
  };
}

function createCacheStub(overrides: Partial<PostCachePort> = {}): PostCachePort {
  return {
    async get() {
      return null;
    },
    async set() {
      return;
    },
    async invalidate() {
      return;
    },
    ...overrides
  };
}

test('createPost seeds home feed/cache and emits post.created event', async () => {
  const upsertCalls: Array<{ ownerId: string; postId: string }> = [];
  const cacheSetCalls: string[] = [];
  const eventCalls: Array<unknown> = [];

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub({
      async createPost(input) {
        return postRecord({
          authorId: input.authorId,
          body: input.body,
          media: input.media
        });
      },
      async upsertHomeFeedEntry(input) {
        upsertCalls.push(input);
      }
    }),
    postCache: createCacheStub({
      async set(post) {
        cacheSetCalls.push(post.id);
      }
    }),
    mediaUrlSigner: {
      signMediaUrl(key: string) {
        return `signed:${key}`;
      }
    } satisfies MediaUrlSignerPort,
    eventPublisher: {
      async publishPostCreated(input) {
        eventCalls.push(input);
      },
      async publishPostLiked() {
        throw new Error('not used');
      }
    } satisfies FeedEventPublisherPort
  });

  const result = await feed.mutations.createPost(
    { body: 'Hello', mediaKeys: ['x.jpg'] },
    feed.helpers.toExecutionContext({ userId: 'user-1' })
  );

  assert.equal(result.id, 'post-1');
  assert.equal(result.likedByMe, false);
  assert.deepEqual(result.media, [{ type: 'image', url: 'signed:x.jpg' }]);
  assert.deepEqual(upsertCalls, [
    { ownerId: 'user-1', postId: 'post-1' },
    { ownerId: 'anon', postId: 'post-1' }
  ]);
  assert.deepEqual(cacheSetCalls, ['post-1']);
  assert.equal(eventCalls.length, 1);
});

test('createPost resolves mediaAssetIds and deduplicates keys', async () => {
  const resolvedCalls: Array<{ assetId: string; userId: string }> = [];

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub({
      async createPost(input) {
        return postRecord({
          authorId: input.authorId,
          body: input.body,
          media: input.media
        });
      }
    }),
    postCache: createCacheStub(),
    mediaUrlSigner: {
      signMediaUrl(key: string) {
        return `signed:${key}`;
      }
    },
    mediaAssetResolver: {
      async resolveOwnedReadyAsset(input) {
        resolvedCalls.push(input);
        return {
          key: input.assetId === 'asset-1' ? 'a.jpg' : 'b.jpg'
        };
      }
    },
    eventPublisher: {
      async publishPostCreated() {
        return;
      },
      async publishPostLiked() {
        return;
      }
    }
  });

  const created = await feed.mutations.createPost(
    {
      body: 'Hello',
      mediaKeys: ['a.jpg'],
      mediaAssetIds: ['asset-1', 'asset-2']
    },
    feed.helpers.toExecutionContext({ userId: 'user-1' })
  );

  assert.deepEqual(resolvedCalls, [
    { assetId: 'asset-1', userId: 'user-1' },
    { assetId: 'asset-2', userId: 'user-1' }
  ]);
  assert.deepEqual(created.media, [
    { type: 'image', url: 'signed:a.jpg' },
    { type: 'image', url: 'signed:b.jpg' }
  ]);
});

test('likePost/unlikePost require auth and invalidate cache', async () => {
  const invalidated: string[] = [];
  const likedEvents: Array<unknown> = [];

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub(),
    postCache: createCacheStub({
      async invalidate(postId) {
        invalidated.push(postId);
      }
    }),
    mediaUrlSigner: { signMediaUrl: (key: string) => key },
    eventPublisher: {
      async publishPostCreated() {
        return;
      },
      async publishPostLiked(input) {
        likedEvents.push(input);
      }
    }
  });

  await assert.rejects(
    () => feed.mutations.likePost({ id: 'p1' }, feed.helpers.toExecutionContext({} as never)),
    UnauthenticatedError
  );

  const ctx = feed.helpers.toExecutionContext({ userId: 'user-1' });
  assert.equal(await feed.mutations.likePost({ id: 'p1' }, ctx), true);
  assert.equal(await feed.mutations.unlikePost({ id: 'p1' }, ctx), true);
  assert.deepEqual(invalidated, ['p1', 'p1']);
  assert.equal(likedEvents.length, 1);
});

test('feed queries enrich posts from cache and repositories', async () => {
  const cached = postRecord({
    id: 'cached-post',
    authorId: 'author-1',
    media: [{ type: 'image', key: 'image.jpg' }]
  });
  const uncached = postRecord({
    id: 'uncached-post',
    authorId: 'author-2',
    media: [{ type: 'video', url: 'https://cdn.test/video.mp4' }],
    createdAt: new Date('2026-02-02T00:00:00.000Z')
  });
  const cacheSets: string[] = [];

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub({
      async findPostById(id) {
        return id === 'uncached-post' ? uncached : null;
      },
      async listPostsByAuthor(input) {
        assert.equal(input.authorId, 'author-2');
        assert.equal(input.take, 3);
        assert.equal(input.cursor, undefined);
        return [uncached, cached];
      },
      async countLikesForPost(postId) {
        return postId === 'cached-post' ? 4 : 2;
      },
      async isLikedByUser(postId, userId) {
        return postId === 'cached-post' && userId === 'viewer-1';
      }
    }),
    postCache: createCacheStub({
      async get(postId) {
        return postId === 'cached-post' ? cached : null;
      },
      async set(post) {
        cacheSets.push(post.id);
      }
    }),
    mediaUrlSigner: {
      signMediaUrl(key: string) {
        return `signed:${key}`;
      }
    },
    eventPublisher: {
      async publishPostCreated() {
        return;
      },
      async publishPostLiked() {
        return;
      }
    }
  });

  const ctx = feed.helpers.toExecutionContext({ userId: 'viewer-1' });
  const cachedResult = await feed.queries.post('cached-post', ctx);
  const uncachedResult = await feed.queries.resolvePostReference('uncached-post', ctx);
  const userPosts = await feed.queries.userPosts('author-2', { limit: 2 }, ctx);

  assert.equal(cachedResult?.likeCount, 4);
  assert.equal(cachedResult?.likedByMe, true);
  assert.deepEqual(cachedResult?.media, [{ type: 'image', url: 'signed:image.jpg' }]);
  assert.equal(uncachedResult?.media[0]?.url, 'https://cdn.test/video.mp4');
  assert.equal(userPosts.edges.length, 2);
  assert.equal(userPosts.pageInfo.hasNextPage, false);
  assert.deepEqual(cacheSets, ['uncached-post', 'uncached-post', 'cached-post']);
  assert.deepEqual(feed.queries.resolveUserReference('user-9'), { id: 'user-9' });
  assert.equal(await feed.queries.postLikeCount('cached-post'), 4);
  assert.equal(await feed.queries.postLikedByViewer('cached-post', {}), false);
  assert.equal(await feed.queries.postLikedByViewer('cached-post', ctx), true);
  assert.deepEqual(await feed.queries.postMedia({ media: ['bad'] }), []);
});

test('feed queries compute metrics and fallback home feed when no home rows exist', async () => {
  const cacheSets: string[] = [];
  const fallbackPost = postRecord({ id: 'fallback-post' });

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub({
      async countPosts(input) {
        return input?.status === 'HIDDEN' ? 2 : 10;
      },
      async countPostsCreatedSince() {
        return 3;
      },
      async countLikes() {
        return 7;
      },
      async listRecentPosts(input) {
        if (input.take === 2) {
          return [fallbackPost];
        }
        return [fallbackPost];
      },
      async listAdminPosts() {
        return [fallbackPost];
      },
      async listHomeFeed() {
        return [];
      },
      async countLikesForPost() {
        return 1;
      }
    }),
    postCache: createCacheStub({
      async set(post) {
        cacheSets.push(post.id);
      }
    }),
    mediaUrlSigner: { signMediaUrl: (key: string) => key },
    eventPublisher: {
      async publishPostCreated() {
        return;
      },
      async publishPostLiked() {
        return;
      }
    }
  });

  const adminCtx = feed.helpers.toExecutionContext({ userId: 'admin-1', roles: ['admin'] });
  const metrics = await feed.queries.adminContentMetrics(adminCtx);
  const recent = await feed.queries.adminRecentPosts({ limit: 99 }, adminCtx);
  const home = await feed.queries.feedHome({ limit: 1 }, {});

  assert.deepEqual(metrics, { totalPosts: 10, hiddenPosts: 2, postsLast24h: 3, totalLikes: 7 });
  assert.equal(recent.length, 1);
  assert.equal(home.edges.length, 1);
  assert.equal(home.pageInfo.hasNextPage, false);
  assert.deepEqual(cacheSets, ['fallback-post']);
});

test('admin post queries and moderation actions require roles and update hidden status', async () => {
  const invalidated: string[] = [];
  const activePost = postRecord({ id: 'post-active', authorId: 'author-1' });
  const hiddenPost = postRecord({
    id: 'post-hidden',
    authorId: 'author-2',
    status: 'HIDDEN',
    hiddenAt: new Date('2026-02-03T00:00:00.000Z'),
    hiddenReason: 'ADMIN_HIDDEN'
  });

  const repository = createRepositoryStub({
    async listAdminPosts(input) {
      return input.status === 'HIDDEN' ? [hiddenPost] : [activePost];
    },
    async updateAdminPostStatus(input) {
      if (input.postId === 'missing-post') {
        return null;
      }
      return {
        ...(input.status === 'HIDDEN' ? activePost : hiddenPost),
        id: input.postId,
        status: input.status,
        hiddenAt: input.status === 'HIDDEN' ? new Date('2026-02-04T00:00:00.000Z') : null,
        hiddenReason: input.hiddenReason ?? null
      };
    },
    async countLikesForPost() {
      return 2;
    }
  });

  const feed = createFeedApplicationModule({
    repository,
    postCache: createCacheStub({
      async invalidate(postId) {
        invalidated.push(postId);
      }
    }),
    mediaUrlSigner: { signMediaUrl: (key: string) => key },
    eventPublisher: {
      async publishPostCreated() {
        return;
      },
      async publishPostLiked() {
        return;
      }
    }
  });

  await assert.rejects(
    () => feed.queries.adminPosts({ limit: 10 }, feed.helpers.toExecutionContext({ userId: 'viewer-1', roles: [] })),
    /FORBIDDEN/
  );

  const adminCtx = feed.helpers.toExecutionContext({ userId: 'admin-1', roles: ['admin'] });
  const hiddenOnly = await feed.queries.adminPosts({ status: 'HIDDEN', limit: 10 }, adminCtx);
  assert.equal(hiddenOnly.edges[0]?.node.id, 'post-hidden');

  const hidden = await feed.mutations.adminHidePost({ postId: 'post-active' }, adminCtx);
  assert.equal(hidden.status, 'HIDDEN');
  assert.equal(hidden.hiddenReason, 'ADMIN_HIDDEN');

  const restored = await feed.mutations.adminRestorePost({ postId: 'post-hidden' }, adminCtx);
  assert.equal(restored.status, 'ACTIVE');
  assert.equal(restored.hiddenReason, null);
  assert.deepEqual(invalidated, ['post-active', 'post-hidden']);
});

test('feedHome supplements sparse home rows with recent posts', async () => {
  const basePost = postRecord({ id: 'post-1', authorId: 'author-1' });
  const extraPost = postRecord({
    id: 'post-2',
    authorId: 'author-2',
    createdAt: new Date('2026-02-02T00:00:00.000Z')
  });

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub({
      async listHomeFeed() {
        return [
          {
            ownerId: 'viewer-1',
            postId: 'post-1',
            rank: 1,
            insertedAt: new Date('2026-02-03T00:00:00.000Z')
          }
        ];
      },
      async findPostById(id) {
        return id === 'post-1' ? basePost : null;
      },
      async listRecentPosts(input) {
        assert.deepEqual(input.excludeIds, ['post-1']);
        assert.equal(input.excludeAuthorId, 'viewer-1');
        return [extraPost];
      },
      async countLikesForPost() {
        return 0;
      },
      async isLikedByUser() {
        return false;
      }
    }),
    postCache: createCacheStub(),
    mediaUrlSigner: { signMediaUrl: (key: string) => key },
    eventPublisher: {
      async publishPostCreated() {
        return;
      },
      async publishPostLiked() {
        return;
      }
    }
  });

  const home = await feed.queries.feedHome(
    { after: undefined, limit: 2 },
    feed.helpers.toExecutionContext({ userId: 'viewer-1' })
  );

  assert.deepEqual(
    home.edges.map((edge) => edge.node.id),
    ['post-1', 'post-2']
  );
});

test('comment and repost flows enrich engagement data and persist through repositories', async () => {
  const rootPost = postRecord({
    id: 'root-post',
    authorId: 'author-1',
    body: 'Original update',
    createdAt: new Date('2026-02-03T00:00:00.000Z'),
    repostOfId: null
  });
  const repostTarget = postRecord({
    id: 'repost-target',
    authorId: 'author-2',
    body: 'Signal boost',
    createdAt: new Date('2026-02-04T00:00:00.000Z'),
    repostOfId: 'root-post'
  });
  const commentRecord: FeedCommentRecord = {
    id: 'comment-1',
    postId: 'root-post',
    authorId: 'viewer-1',
    body: 'Great post',
    createdAt: new Date('2026-02-05T10:00:00.000Z')
  };
  const commentDeleteCalls: Array<{ id: string; authorId: string }> = [];
  const repostCreateCalls: Array<{
    authorId: string;
    body: string;
    media: unknown;
    repostOfId?: string | null;
  }> = [];
  const homeFeedCalls: Array<{ ownerId: string; postId: string }> = [];
  const cacheSets: string[] = [];
  const publishedEvents: Array<unknown> = [];

  const feed = createFeedApplicationModule({
    repository: createRepositoryStub({
      async findPostById(id) {
        if (id === 'root-post') return rootPost;
        if (id === 'repost-target') return repostTarget;
        return null;
      },
      async countLikesForPost(postId) {
        return postId === 'root-post' ? 5 : 0;
      },
      async countCommentsForPost(postId) {
        return postId === 'root-post' ? 3 : 0;
      },
      async countRepostsForPost(postId) {
        return postId === 'root-post' ? 4 : 0;
      },
      async listCommentsByPost(input) {
        assert.equal(input.postId, 'root-post');
        assert.equal(input.take, 3);
        return [
          commentRecord,
          {
            ...commentRecord,
            id: 'comment-2',
            body: 'Second note',
            createdAt: new Date('2026-02-05T09:00:00.000Z')
          },
          {
            ...commentRecord,
            id: 'comment-3',
            body: 'Third note',
            createdAt: new Date('2026-02-05T08:00:00.000Z')
          }
        ];
      },
      async createComment(input) {
        assert.deepEqual(input, {
          postId: 'root-post',
          authorId: 'viewer-1',
          body: 'Great post'
        });
        return commentRecord;
      },
      async findCommentById(id) {
        return id === 'comment-1' ? commentRecord : null;
      },
      async deleteCommentIfAuthor(input) {
        commentDeleteCalls.push(input);
        return true;
      },
      async createPost(input) {
        repostCreateCalls.push(input);
        return postRecord({
          id: 'repost-created',
          authorId: input.authorId,
          body: input.body,
          media: input.media,
          createdAt: new Date('2026-02-06T00:00:00.000Z'),
          repostOfId: input.repostOfId ?? null
        });
      },
      async upsertHomeFeedEntry(input) {
        homeFeedCalls.push(input);
      }
    }),
    postCache: createCacheStub({
      async set(post) {
        cacheSets.push(post.id);
      }
    }),
    mediaUrlSigner: {
      signMediaUrl(key: string) {
        return `signed:${key}`;
      }
    },
    eventPublisher: {
      async publishPostCreated(input) {
        publishedEvents.push(input);
      },
      async publishPostLiked() {
        return;
      }
    }
  });

  const ctx = feed.helpers.toExecutionContext({ userId: 'viewer-1' });
  const commentCount = await feed.queries.postCommentCount('root-post');
  const repostCount = await feed.queries.postRepostCount('root-post');
  const repostOf = await feed.queries.postRepostOf({ repostOfId: 'root-post' }, ctx);
  const comments = await feed.queries.postComments('root-post', { limit: 2 });
  const createdComment = await feed.mutations.createComment({ postId: 'root-post', body: '  Great post  ' }, ctx);
  const deletedComment = await feed.mutations.deleteComment({ id: 'comment-1' }, ctx);
  const repost = await feed.mutations.repostPost({ id: 'repost-target', body: '  Read this  ' }, ctx);

  assert.equal(commentCount, 3);
  assert.equal(repostCount, 4);
  assert.equal(repostOf?.id, 'root-post');
  assert.equal(repostOf?.commentCount, 3);
  assert.equal(repostOf?.repostCount, 4);
  assert.equal(comments.edges.length, 2);
  assert.equal(comments.pageInfo.hasNextPage, true);
  assert.equal(createdComment.body, 'Great post');
  assert.equal(createdComment.author.id, 'viewer-1');
  assert.equal(deletedComment, true);
  assert.deepEqual(commentDeleteCalls, [{ id: 'comment-1', authorId: 'viewer-1' }]);
  assert.deepEqual(repostCreateCalls, [
    {
      authorId: 'viewer-1',
      body: 'Read this',
      media: [],
      repostOfId: 'root-post'
    }
  ]);
  assert.deepEqual(homeFeedCalls, [
    { ownerId: 'viewer-1', postId: 'repost-created' },
    { ownerId: 'anon', postId: 'repost-created' }
  ]);
  assert.deepEqual(cacheSets, ['root-post', 'root-post', 'repost-target', 'root-post', 'repost-created', 'root-post']);
  assert.equal(publishedEvents.length, 1);
  assert.equal(repost.repostOf?.id, 'root-post');
  assert.equal(repost.commentCount, 0);
  assert.equal(repost.repostCount, 0);
});
