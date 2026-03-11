import type { ProfileUserModerationEventData } from '../../contracts/profile-events.js';

export interface ProfileModerationIntegrationEvent {
  event_id?: string;
  event_type?: string;
  data?: Partial<ProfileUserModerationEventData> | null;
}

export interface ProfileModerationMessageMetadata {
  topic: string;
  partition: number;
  offset: string;
  consumerGroup: string;
}

export interface ProfileModerationStorePort {
  hideAuthorPosts(authorId: string): Promise<string[]>;
  restoreAuthorPosts(authorId: string): Promise<string[]>;
  invalidatePostCache(postId: string): Promise<void>;
}

export interface ProfileModerationInboxStorePort {
  claimInboxEvent(input: {
    consumerGroup: string;
    topic: string;
    partition: number;
    offset: string;
    eventId?: string;
    eventKey: string;
  }): Promise<boolean>;
  markInboxEventProcessed(input: {
    consumerGroup: string;
    eventKey: string;
  }): Promise<void>;
  markInboxEventFailed(input: {
    consumerGroup: string;
    eventKey: string;
    errorMessage: string;
  }): Promise<void>;
}

export type ProfileModerationHandleResult =
  | { status: 'skipped_missing_user' }
  | { status: 'skipped_unsupported_event' }
  | { status: 'processed'; affectedPostIds: string[] };

export type ProfileModerationInboxHandleResult =
  | ProfileModerationHandleResult
  | { status: 'skipped_duplicate' };

function toInboxEventKey(
  event: ProfileModerationIntegrationEvent,
  meta: ProfileModerationMessageMetadata
): string {
  if (event.event_id?.trim()) {
    return event.event_id.trim();
  }

  return `${meta.topic}:${meta.partition}:${meta.offset}`;
}

export class ProfileModerationSyncHandler {
  constructor(private readonly store: ProfileModerationStorePort) {}

  async execute(event: ProfileModerationIntegrationEvent): Promise<ProfileModerationHandleResult> {
    const userId = event.data?.user_id;
    if (!userId) {
      return { status: 'skipped_missing_user' };
    }

    switch (event.event_type) {
      case 'profile.user.deactivated.v1': {
        const affectedPostIds = await this.store.hideAuthorPosts(userId);
        await Promise.all(affectedPostIds.map((postId) => this.store.invalidatePostCache(postId)));
        return { status: 'processed', affectedPostIds };
      }
      case 'profile.user.reactivated.v1': {
        const affectedPostIds = await this.store.restoreAuthorPosts(userId);
        await Promise.all(affectedPostIds.map((postId) => this.store.invalidatePostCache(postId)));
        return { status: 'processed', affectedPostIds };
      }
      default:
        return { status: 'skipped_unsupported_event' };
    }
  }
}

export class ProfileModerationInboxHandler {
  constructor(
    private readonly moderation: ProfileModerationSyncHandler,
    private readonly inboxStore: ProfileModerationInboxStorePort
  ) {}

  async execute(
    event: ProfileModerationIntegrationEvent,
    meta: ProfileModerationMessageMetadata
  ): Promise<ProfileModerationInboxHandleResult> {
    const eventKey = toInboxEventKey(event, meta);
    const claimed = await this.inboxStore.claimInboxEvent({
      consumerGroup: meta.consumerGroup,
      topic: meta.topic,
      partition: meta.partition,
      offset: meta.offset,
      eventId: event.event_id,
      eventKey
    });

    if (!claimed) {
      return { status: 'skipped_duplicate' };
    }

    try {
      const result = await this.moderation.execute(event);
      await this.inboxStore.markInboxEventProcessed({
        consumerGroup: meta.consumerGroup,
        eventKey
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.inboxStore.markInboxEventFailed({
        consumerGroup: meta.consumerGroup,
        eventKey,
        errorMessage: message
      });
      throw error;
    }
  }
}

