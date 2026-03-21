import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeHomeFeedRank,
  seedHomeFeedRank
} from '../src/application/feed/home-feed-ranking.js';

test('newer posts beat older posts by default', () => {
  const older = new Date('2026-02-01T00:00:00.000Z');
  const newer = new Date('2026-02-01T00:01:00.000Z');

  assert.ok(computeHomeFeedRank({
    createdAt: newer,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    now: newer
  }) > computeHomeFeedRank({
    createdAt: older,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    now: newer
  }));
});

test('engagement can reorder nearby recent posts', () => {
  const now = new Date('2026-02-03T00:00:00.000Z');
  const older = new Date('2026-02-02T23:40:00.000Z');
  const newer = new Date('2026-02-03T00:00:00.000Z');

  const engagedOlder = computeHomeFeedRank({
    createdAt: older,
    likeCount: 10,
    commentCount: 10,
    repostCount: 5,
    now
  });
  const plainNewer = computeHomeFeedRank({
    createdAt: newer,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    now
  });

  assert.ok(engagedOlder > plainNewer);
});

test('engagement bonus caps are enforced', () => {
  const now = new Date('2026-02-03T00:00:00.000Z');
  const createdAt = new Date('2026-02-02T23:59:00.000Z');

  const capped = computeHomeFeedRank({
    createdAt,
    likeCount: 50,
    commentCount: 50,
    repostCount: 50,
    now
  });
  const expected =
    seedHomeFeedRank(createdAt) +
    BigInt(10 * 60_000) +
    BigInt(10 * 120_000) +
    BigInt(5 * 180_000);

  assert.equal(capped, expected);
});

test('posts older than the engagement window do not receive boosts', () => {
  const now = new Date('2026-02-03T00:00:00.000Z');
  const olderThanWindow = new Date('2026-02-01T23:59:59.999Z');

  assert.equal(
    computeHomeFeedRank({
      createdAt: olderThanWindow,
      likeCount: 10,
      commentCount: 10,
      repostCount: 5,
      now
    }),
    seedHomeFeedRank(olderThanWindow)
  );
});
