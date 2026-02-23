import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeedApplicationModule
} from '../src/application/feed/use-cases.js';
import type {
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
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides
  };
}

function createRepositoryStub(overrides: Partial<FeedRepositoryPort> = {}): FeedRepositoryPort {
  return {
    async findPostById() {
      return null;
    },
    async listPostsByAuthor() {
      return [];
    },
    async listRecentPosts() {
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
    async countLikes() {
      return 0;
    },
    async countLikesForPost() {
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
  assert.equal(result.likedByMe, true);
  assert.deepEqual(result.media, [{ type: 'image', url: 'signed:x.jpg' }]);
  assert.deepEqual(upsertCalls, [
    { ownerId: 'user-1', postId: 'post-1' },
    { ownerId: 'anon', postId: 'post-1' }
  ]);
  assert.deepEqual(cacheSetCalls, ['post-1']);
  assert.equal(eventCalls.length, 1);
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

