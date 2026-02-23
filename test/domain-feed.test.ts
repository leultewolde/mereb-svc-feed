import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoredPostMediaPayload,
  mediaTypeFromKey,
  normalizeCreatedAt
} from '../src/domain/feed/post.js';
import { UnauthenticatedError } from '../src/domain/feed/errors.js';
import { postCreatedEvent, postLikedEvent } from '../src/domain/feed/events.js';

test('buildStoredPostMediaPayload infers media types from keys', () => {
  assert.equal(mediaTypeFromKey('clip.mp4'), 'video');
  assert.equal(mediaTypeFromKey('photo.jpg'), 'image');
  assert.deepEqual(buildStoredPostMediaPayload(['a.jpg', 'b.mp4']), [
    { type: 'image', key: 'a.jpg' },
    { type: 'video', key: 'b.mp4' }
  ]);
});

test('normalizeCreatedAt returns ISO string for common inputs', () => {
  const now = new Date('2026-02-01T00:00:00.000Z');
  assert.equal(normalizeCreatedAt(now), '2026-02-01T00:00:00.000Z');
  assert.equal(normalizeCreatedAt('2026-02-01T00:00:00.000Z'), '2026-02-01T00:00:00.000Z');
});

test('feed domain errors/events preserve expected shapes', () => {
  const auth = new UnauthenticatedError();
  assert.equal(auth.message, 'UNAUTHENTICATED');

  const created = postCreatedEvent({
    postId: 'p1',
    authorId: 'u1',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    visibility: 'public'
  });
  assert.equal(created.type, 'PostCreated');
  assert.equal(created.payload.postId, 'p1');

  const liked = postLikedEvent({ postId: 'p1', userId: 'u2' });
  assert.equal(liked.type, 'PostLiked');
  assert.equal(liked.payload.userId, 'u2');
});

