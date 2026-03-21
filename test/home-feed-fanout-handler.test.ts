import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  HomeFeedFanoutOnPostCreatedHandler,
  HomeFeedPostCreatedInboxHandler,
  type HomeFeedConsumerMessageMetadata,
  type HomeFeedFanoutRow,
  type HomeFeedFanoutStorePort,
  type HomeFeedInboxStorePort
} from '../src/application/feed/home-feed-fanout.js';
import { seedHomeFeedRank } from '../src/application/feed/home-feed-ranking.js';

test('skips event when required ids are missing', async () => {
  let inserted = false;
  const handler = new HomeFeedFanoutOnPostCreatedHandler({
    async listFollowerIds() {
      throw new Error('should not be called');
    },
    async insertHomeFeedRows() {
      inserted = true;
    }
  });

  const result = await handler.execute({
    data: {
      author_id: 'user-1'
    }
  });

  assert.deepEqual(result, { status: 'skipped_missing_ids' });
  assert.equal(inserted, false);
});

test('fans out to anon + author + followers with de-duplication and uses created_at', async () => {
  let followerLookupAuthorId: string | null = null;
  let insertedRows: HomeFeedFanoutRow[] = [];
  let batchSize: number | undefined;

  const store: HomeFeedFanoutStorePort = {
    async listFollowerIds(authorId) {
      followerLookupAuthorId = authorId;
      return ['u2', 'u3', 'u2'];
    },
    async insertHomeFeedRows(rows, requestedBatchSize) {
      insertedRows = rows;
      batchSize = requestedBatchSize;
    }
  };

  const handler = new HomeFeedFanoutOnPostCreatedHandler(store, () => {
    return new Date('2030-01-01T00:00:00.000Z');
  });

  const result = await handler.execute({
    data: {
      post_id: 'post-1',
      author_id: 'u1',
      created_at: '2026-02-22T22:00:00.000Z'
    }
  });

  assert.deepEqual(result, { status: 'processed', recipientsCount: 4 });
  assert.equal(followerLookupAuthorId, 'u1');
  assert.equal(batchSize, 500);
  assert.deepEqual(
    insertedRows.map((row) => row.ownerId).sort(),
    ['anon', 'u1', 'u2', 'u3']
  );
  assert.ok(insertedRows.every((row) => row.postId === 'post-1'));
  assert.ok(
    insertedRows.every(
      (row) => row.insertedAt.toISOString() === '2026-02-22T22:00:00.000Z'
    )
  );
  assert.ok(
    insertedRows.every(
      (row) => row.rank === seedHomeFeedRank(new Date('2026-02-22T22:00:00.000Z'))
    )
  );
});

test('uses injected current time when created_at is absent', async () => {
  let insertedRows: HomeFeedFanoutRow[] = [];

  const handler = new HomeFeedFanoutOnPostCreatedHandler(
    {
      async listFollowerIds() {
        return [];
      },
      async insertHomeFeedRows(rows) {
        insertedRows = rows;
      }
    },
    () => new Date('2031-01-01T00:00:00.000Z')
  );

  const result = await handler.execute({
    data: {
      post_id: 'post-2',
      author_id: 'u10'
    }
  });

  assert.deepEqual(result, { status: 'processed', recipientsCount: 2 });
  assert.ok(
    insertedRows.every(
      (row) => row.insertedAt.toISOString() === '2031-01-01T00:00:00.000Z'
    )
  );
  assert.ok(
    insertedRows.every(
      (row) => row.rank === seedHomeFeedRank(new Date('2031-01-01T00:00:00.000Z'))
    )
  );
});

function messageMeta(overrides: Partial<HomeFeedConsumerMessageMetadata> = {}): HomeFeedConsumerMessageMetadata {
  return {
    topic: 'post.created.v1',
    partition: 0,
    offset: '12',
    consumerGroup: 'svc-feed-home-feed',
    ...overrides
  };
}

test('inbox handler skips duplicates when claim fails', async () => {
  const inboxCalls: Array<unknown> = [];
  const inbox: HomeFeedInboxStorePort = {
    async claimInboxEvent(input) {
      inboxCalls.push(input);
      return false;
    },
    async markInboxEventProcessed() {
      throw new Error('should not be called');
    },
    async markInboxEventFailed() {
      throw new Error('should not be called');
    }
  };

  const fanout = new HomeFeedFanoutOnPostCreatedHandler({
    async listFollowerIds() {
      throw new Error('should not be called');
    },
    async insertHomeFeedRows() {
      throw new Error('should not be called');
    }
  });

  const handler = new HomeFeedPostCreatedInboxHandler(fanout, inbox);
  const result = await handler.execute(
    {
      event_id: 'evt-1',
      data: { post_id: 'p1', author_id: 'u1' }
    },
    messageMeta()
  );

  assert.deepEqual(result, { status: 'skipped_duplicate' });
  assert.equal(inboxCalls.length, 1);
});

test('inbox handler claims, processes, and marks processed', async () => {
  const lifecycle: string[] = [];
  const inbox: HomeFeedInboxStorePort = {
    async claimInboxEvent(input) {
      lifecycle.push(`claim:${input.eventKey}`);
      return true;
    },
    async markInboxEventProcessed(input) {
      lifecycle.push(`processed:${input.eventKey}`);
    },
    async markInboxEventFailed() {
      lifecycle.push('failed');
    }
  };

  const fanout = new HomeFeedFanoutOnPostCreatedHandler({
    async listFollowerIds() {
      return [];
    },
    async insertHomeFeedRows() {
      lifecycle.push('insert');
    }
  });

  const handler = new HomeFeedPostCreatedInboxHandler(fanout, inbox);
  const result = await handler.execute(
    {
      event_id: 'evt-2',
      data: { post_id: 'p2', author_id: 'u2' }
    },
    messageMeta()
  );

  assert.equal(result.status, 'processed');
  assert.deepEqual(lifecycle, ['claim:evt-2', 'insert', 'processed:evt-2']);
});

test('inbox handler marks failed when fanout throws and rethrows', async () => {
  const lifecycle: string[] = [];
  const inbox: HomeFeedInboxStorePort = {
    async claimInboxEvent(input) {
      lifecycle.push(`claim:${input.eventKey}`);
      return true;
    },
    async markInboxEventProcessed() {
      lifecycle.push('processed');
    },
    async markInboxEventFailed(input) {
      lifecycle.push(`failed:${input.eventKey}:${input.errorMessage}`);
    }
  };

  const fanout = new HomeFeedFanoutOnPostCreatedHandler({
    async listFollowerIds() {
      throw new Error('db down');
    },
    async insertHomeFeedRows() {
      return;
    }
  });

  const handler = new HomeFeedPostCreatedInboxHandler(fanout, inbox);

  await assert.rejects(
    () =>
      handler.execute(
        {
          data: { post_id: 'p3', author_id: 'u3' }
        },
        messageMeta({ topic: 'post.created.v1', partition: 1, offset: '99' })
      ),
    /db down/
  );

  assert.deepEqual(lifecycle, [
    'claim:post.created.v1:1:99',
    'failed:post.created.v1:1:99:db down'
  ]);
});
