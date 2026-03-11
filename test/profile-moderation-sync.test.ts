import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ProfileModerationInboxHandler,
  ProfileModerationSyncHandler,
  type ProfileModerationInboxStorePort,
  type ProfileModerationStorePort
} from '../src/application/feed/profile-moderation-sync.js';

class FakeModerationStore implements ProfileModerationStorePort {
  hideCalls: string[] = [];
  restoreCalls: string[] = [];
  invalidated: string[] = [];

  async hideAuthorPosts(authorId: string): Promise<string[]> {
    this.hideCalls.push(authorId);
    return ['post-1', 'post-2'];
  }

  async restoreAuthorPosts(authorId: string): Promise<string[]> {
    this.restoreCalls.push(authorId);
    return ['post-3'];
  }

  async invalidatePostCache(postId: string): Promise<void> {
    this.invalidated.push(postId);
  }
}

class FakeInboxStore implements ProfileModerationInboxStorePort {
  claimResult = true;
  claimed: Array<Record<string, unknown>> = [];
  processed: Array<Record<string, unknown>> = [];
  failed: Array<Record<string, unknown>> = [];

  async claimInboxEvent(input: {
    consumerGroup: string;
    topic: string;
    partition: number;
    offset: string;
    eventId?: string;
    eventKey: string;
  }): Promise<boolean> {
    this.claimed.push(input);
    return this.claimResult;
  }

  async markInboxEventProcessed(input: {
    consumerGroup: string;
    eventKey: string;
  }): Promise<void> {
    this.processed.push(input);
  }

  async markInboxEventFailed(input: {
    consumerGroup: string;
    eventKey: string;
    errorMessage: string;
  }): Promise<void> {
    this.failed.push(input);
  }
}

test('profile moderation sync hides or restores author posts and skips unsupported payloads', async () => {
  const store = new FakeModerationStore();
  const handler = new ProfileModerationSyncHandler(store);

  const deactivated = await handler.execute({
    event_type: 'profile.user.deactivated.v1',
    data: { user_id: 'user-1' }
  });
  assert.deepEqual(deactivated, {
    status: 'processed',
    affectedPostIds: ['post-1', 'post-2']
  });
  assert.deepEqual(store.hideCalls, ['user-1']);
  assert.deepEqual(store.invalidated, ['post-1', 'post-2']);

  const reactivated = await handler.execute({
    event_type: 'profile.user.reactivated.v1',
    data: { user_id: 'user-1' }
  });
  assert.deepEqual(reactivated, {
    status: 'processed',
    affectedPostIds: ['post-3']
  });
  assert.deepEqual(store.restoreCalls, ['user-1']);
  assert.deepEqual(store.invalidated, ['post-1', 'post-2', 'post-3']);

  assert.deepEqual(await handler.execute({ event_type: 'profile.user.deactivated.v1', data: {} }), {
    status: 'skipped_missing_user'
  });
  assert.deepEqual(await handler.execute({ event_type: 'profile.user.unknown.v1', data: { user_id: 'user-1' } }), {
    status: 'skipped_unsupported_event'
  });
});

test('profile moderation inbox handler skips duplicates, marks success, and records failures', async () => {
  const inbox = new FakeInboxStore();
  const moderation = {
    execute: async () => ({ status: 'processed', affectedPostIds: ['post-9'] } as const)
  };
  const handler = new ProfileModerationInboxHandler(moderation, inbox);
  const meta = {
    topic: 'profile.user.deactivated.v1',
    partition: 2,
    offset: '42',
    consumerGroup: 'svc-feed-profile-moderation'
  };

  inbox.claimResult = false;
  assert.deepEqual(await handler.execute({ event_type: 'profile.user.deactivated.v1', data: { user_id: 'user-1' } }, meta), {
    status: 'skipped_duplicate'
  });

  inbox.claimResult = true;
  const processed = await handler.execute(
    {
      event_id: 'event-1',
      event_type: 'profile.user.deactivated.v1',
      data: { user_id: 'user-1' }
    },
    meta
  );
  assert.deepEqual(processed, { status: 'processed', affectedPostIds: ['post-9'] });
  assert.deepEqual(inbox.processed, [
    {
      consumerGroup: 'svc-feed-profile-moderation',
      eventKey: 'event-1'
    }
  ]);

  const failingHandler = new ProfileModerationInboxHandler(
    {
      async execute() {
        throw new Error('boom');
      }
    },
    inbox
  );

  await assert.rejects(
    () =>
      failingHandler.execute(
        {
          event_type: 'profile.user.reactivated.v1',
          data: { user_id: 'user-2' }
        },
        {
          topic: 'profile.user.reactivated.v1',
          partition: 3,
          offset: '11',
          consumerGroup: 'svc-feed-profile-moderation'
        }
      ),
    /boom/
  );

  assert.deepEqual(inbox.failed.at(-1), {
    consumerGroup: 'svc-feed-profile-moderation',
    eventKey: 'profile.user.reactivated.v1:3:11',
    errorMessage: 'boom'
  });
});
