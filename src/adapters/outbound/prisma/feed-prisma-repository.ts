import { randomUUID } from 'node:crypto';
import { Prisma, type Post, type PrismaClient } from '../../../../generated/client/index.js';
import { prisma } from '../../../prisma.js';
import type {
  FeedEventPublisherPort,
  FeedMutationPorts,
  FeedPostRecord,
  FeedRepositoryPort,
  FeedTransactionPort,
  HomeFeedRowRecord
} from '../../../application/feed/ports.js';

type FeedPrismaDb = PrismaClient | Prisma.TransactionClient;

function toFeedPostRecord(post: Post): FeedPostRecord {
  return {
    id: post.id,
    authorId: post.authorId,
    body: post.body,
    media: post.media,
    visibility: post.visibility,
    createdAt: post.createdAt
  };
}

function toHomeFeedRowRecord(input: {
  ownerId: string;
  postId: string;
  rank: number;
  insertedAt: Date;
}): HomeFeedRowRecord {
  return {
    ownerId: input.ownerId,
    postId: input.postId,
    rank: input.rank,
    insertedAt: input.insertedAt
  };
}

export class PrismaFeedRepository implements FeedRepositoryPort {
  constructor(private readonly db: FeedPrismaDb = prisma) {}

  async findPostById(id: string): Promise<FeedPostRecord | null> {
    const post = await this.db.post.findUnique({ where: { id } });
    return post ? toFeedPostRecord(post) : null;
  }

  async listPostsByAuthor(input: {
    authorId: string;
    cursor?: { createdAt: Date; id: string };
    take: number;
  }): Promise<FeedPostRecord[]> {
    const items = await this.db.post.findMany({
      where: {
        authorId: input.authorId,
        ...(input.cursor
          ? {
              OR: [
                { createdAt: { lt: input.cursor.createdAt } },
                {
                  createdAt: input.cursor.createdAt,
                  id: { lt: input.cursor.id }
                }
              ]
            }
          : {})
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.take
    });

    return items.map(toFeedPostRecord);
  }

  async listRecentPosts(input: {
    take: number;
    excludeIds?: string[];
    excludeAuthorId?: string;
  }): Promise<FeedPostRecord[]> {
    const where: Prisma.PostWhereInput = {};
    if (input.excludeIds && input.excludeIds.length > 0) {
      where.id = { notIn: input.excludeIds };
    }
    if (input.excludeAuthorId) {
      where.authorId = { not: input.excludeAuthorId };
    }

    const items = await this.db.post.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.take
    });

    return items.map(toFeedPostRecord);
  }

  async listHomeFeed(input: {
    ownerId: string;
    cursor?: { createdAt: Date; id: string };
    take: number;
  }): Promise<HomeFeedRowRecord[]> {
    const where: Prisma.HomeFeedWhereInput = {
      ownerId: input.ownerId
    };

    if (input.cursor) {
      where.AND = [
        {
          OR: [
            { insertedAt: { lt: input.cursor.createdAt } },
            {
              AND: [
                { insertedAt: input.cursor.createdAt },
                { postId: { lt: input.cursor.id } }
              ]
            }
          ]
        }
      ];
    }

    const rows = await this.db.homeFeed.findMany({
      where,
      orderBy: [{ insertedAt: 'desc' }, { postId: 'desc' }],
      take: input.take
    });

    return rows.map(toHomeFeedRowRecord);
  }

  async createPost(input: {
    authorId: string;
    body: string;
    media: Array<{ type: string; key: string }>;
  }): Promise<FeedPostRecord> {
    const post = await this.db.post.create({
      data: {
        authorId: input.authorId,
        body: input.body,
        media: input.media
      }
    });
    return toFeedPostRecord(post);
  }

  async upsertHomeFeedEntry(input: { ownerId: string; postId: string }): Promise<void> {
    await this.db.homeFeed.upsert({
      where: {
        ownerId_postId: {
          ownerId: input.ownerId,
          postId: input.postId
        }
      },
      create: {
        ownerId: input.ownerId,
        postId: input.postId,
        rank: 0
      },
      update: {}
    });
  }

  async countPosts(): Promise<number> {
    return this.db.post.count();
  }

  async countPostsCreatedSince(since: Date): Promise<number> {
    return this.db.post.count({
      where: {
        createdAt: { gte: since }
      }
    });
  }

  async countLikes(): Promise<number> {
    return this.db.like.count();
  }

  async countLikesForPost(postId: string): Promise<number> {
    return this.db.like.count({ where: { postId } });
  }

  async isLikedByUser(postId: string, userId: string): Promise<boolean> {
    const like = await this.db.like.findUnique({
      where: {
        userId_postId: {
          userId,
          postId
        }
      }
    });
    return Boolean(like);
  }

  async upsertLike(input: { postId: string; userId: string }): Promise<void> {
    await this.db.like.upsert({
      where: {
        userId_postId: {
          userId: input.userId,
          postId: input.postId
        }
      },
      update: {},
      create: {
        userId: input.userId,
        postId: input.postId
      }
    });
  }

  async deleteLikeIfExists(input: { postId: string; userId: string }): Promise<void> {
    await this.db.like
      .delete({
        where: {
          userId_postId: {
            userId: input.userId,
            postId: input.postId
          }
        }
      })
      .catch(() => undefined);
  }
}

export class PrismaFeedOutboxEventPublisher implements FeedEventPublisherPort {
  constructor(private readonly db: FeedPrismaDb = prisma) {}

  async publishPostCreated(input: {
    postId: string;
    authorId: string;
    createdAt: Date;
    visibility: string;
  }): Promise<void> {
    await this.db.outboxEvent.create({
      data: {
        id: randomUUID(),
        topic: 'post.created.v1',
        eventKey: input.postId,
        payload: {
          event_id: randomUUID(),
          event_type: 'post.created.v1',
          occurred_at: new Date().toISOString(),
          producer: 'svc-feed',
          data: {
            post_id: input.postId,
            author_id: input.authorId,
            created_at: input.createdAt.toISOString(),
            visibility: input.visibility
          }
        } as Prisma.InputJsonValue
      }
    });
  }

  async publishPostLiked(input: { postId: string; userId: string }): Promise<void> {
    await this.db.outboxEvent.create({
      data: {
        id: randomUUID(),
        topic: 'post.liked.v1',
        eventKey: input.postId,
        payload: {
          event_id: randomUUID(),
          event_type: 'post.liked.v1',
          occurred_at: new Date().toISOString(),
          producer: 'svc-feed',
          postId: input.postId,
          userId: input.userId
        } as Prisma.InputJsonValue
      }
    });
  }
}

export interface PendingFeedOutboxEvent {
  id: string;
  topic: string;
  eventKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

export class PrismaFeedOutboxRelayStore {
  constructor(private readonly db: FeedPrismaDb = prisma) {}

  async listDue(limit: number, now = new Date()): Promise<PendingFeedOutboxEvent[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        nextAttemptAt: { lte: now }
      },
      orderBy: [{ createdAt: 'asc' }],
      take: limit
    });

    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      eventKey: row.eventKey,
      payload: row.payload as Record<string, unknown>,
      attempts: row.attempts
    }));
  }

  async claim(id: string): Promise<boolean> {
    const result = await this.db.outboxEvent.updateMany({
      where: {
        id,
        status: { in: ['PENDING', 'FAILED'] }
      },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lastError: null
      }
    });
    return result.count > 0;
  }

  async markPublished(id: string, publishedAt = new Date()): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt,
        lastError: null
      }
    });
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: 'FAILED',
        lastError: error.slice(0, 4000),
        nextAttemptAt,
        publishedAt: null
      }
    });
  }
}

export class PrismaFeedTransactionRunner implements FeedTransactionPort {
  async run<T>(callback: (ports: FeedMutationPorts) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) =>
      callback({
        repository: new PrismaFeedRepository(tx),
        eventPublisher: new PrismaFeedOutboxEventPublisher(tx)
      })
    );
  }
}

