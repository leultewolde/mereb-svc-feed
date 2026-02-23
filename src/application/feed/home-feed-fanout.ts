import type { FeedPostCreatedEventData } from '../../contracts/feed-events.js';

const DEFAULT_INSERT_BATCH_SIZE = 500;

export interface HomeFeedFanoutRow {
  ownerId: string;
  postId: string;
  insertedAt: Date;
}

export interface HomeFeedFanoutStorePort {
  listFollowerIds(authorId: string): Promise<string[]>;
  insertHomeFeedRows(rows: HomeFeedFanoutRow[], batchSize?: number): Promise<void>;
}

export interface FeedPostCreatedIntegrationEvent {
  event_id?: string;
  data?: Partial<FeedPostCreatedEventData> | null;
}

export interface HomeFeedConsumerMessageMetadata {
  topic: string;
  partition: number;
  offset: string;
  consumerGroup: string;
}

export interface HomeFeedInboxStorePort {
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

export type HomeFeedFanoutHandleResult =
  | { status: 'skipped_missing_ids' }
  | { status: 'processed'; recipientsCount: number };

export type HomeFeedInboxHandleResult =
  | HomeFeedFanoutHandleResult
  | { status: 'skipped_duplicate' };

export class HomeFeedFanoutOnPostCreatedHandler {
  constructor(
    private readonly store: HomeFeedFanoutStorePort,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(
    event: FeedPostCreatedIntegrationEvent
  ): Promise<HomeFeedFanoutHandleResult> {
    const postId = event.data?.post_id;
    const authorId = event.data?.author_id;
    if (!postId || !authorId) {
      return { status: 'skipped_missing_ids' };
    }

    const followers = await this.store.listFollowerIds(authorId);
    const recipients = new Set<string>(['anon', authorId, ...followers]);
    if (recipients.size === 0) {
      return { status: 'processed', recipientsCount: 0 };
    }

    const insertedAt = event.data?.created_at
      ? new Date(event.data.created_at)
      : this.now();
    const rows: HomeFeedFanoutRow[] = Array.from(recipients).map((ownerId) => ({
      ownerId,
      postId,
      insertedAt
    }));

    await this.store.insertHomeFeedRows(rows, DEFAULT_INSERT_BATCH_SIZE);

    return {
      status: 'processed',
      recipientsCount: recipients.size
    };
  }
}

function toInboxEventKey(
  event: FeedPostCreatedIntegrationEvent,
  meta: HomeFeedConsumerMessageMetadata
): string {
  if (event.event_id?.trim()) {
    return event.event_id.trim();
  }

  return `${meta.topic}:${meta.partition}:${meta.offset}`;
}

export class HomeFeedPostCreatedInboxHandler {
  constructor(
    private readonly fanout: HomeFeedFanoutOnPostCreatedHandler,
    private readonly inboxStore: HomeFeedInboxStorePort
  ) {}

  async execute(
    event: FeedPostCreatedIntegrationEvent,
    meta: HomeFeedConsumerMessageMetadata
  ): Promise<HomeFeedInboxHandleResult> {
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
      const result = await this.fanout.execute(event);
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
