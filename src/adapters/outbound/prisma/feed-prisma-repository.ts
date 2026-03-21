import { randomUUID } from 'node:crypto';
import {
  type Comment,
  OutboxEventStatus,
  PostHiddenReason,
  PostStatus,
  Prisma,
  type Post,
  type PrismaClient
} from '../../../../generated/client/index.js';
import { prisma } from '../../../prisma.js';
import type {
  AdminPostRecord,
  FeedCommentRecord,
  FeedEventPublisherPort,
  FeedMutationPorts,
  FeedPostRecord,
  FeedRepositoryPort,
  FeedTransactionPort,
  HomeFeedRowRecord,
  PostEngagementStatsRecord
} from '../../../application/feed/ports.js';
import type { AdminPostHiddenReason, AdminPostStatus } from '../../../domain/feed/post.js';
import { seedHomeFeedRank } from '../../../application/feed/home-feed-ranking.js';

type FeedPrismaDb = PrismaClient | Prisma.TransactionClient;

function toFeedPostRecord(post: Post): FeedPostRecord {
  return {
    id: post.id,
    authorId: post.authorId,
    body: post.body,
    media: post.media,
    visibility: post.visibility,
    repostOfId: post.repostOfId,
    status: post.status,
    hiddenAt: post.hiddenAt,
    hiddenReason: post.hiddenReason,
    createdAt: post.createdAt
  };
}

function toFeedCommentRecord(comment: Comment): FeedCommentRecord {
  return {
    id: comment.id,
    postId: comment.postId,
    authorId: comment.authorId,
    body: comment.body,
    createdAt: comment.createdAt
  };
}

function toHomeFeedRowRecord(input: {
  ownerId: string;
  postId: string;
  rank: bigint;
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
    const post = await this.db.post.findFirst({
      where: {
        id,
        status: PostStatus.ACTIVE
      }
    });
    return post ? toFeedPostRecord(post) : null;
  }

  async findAdminPostById(id: string): Promise<AdminPostRecord | null> {
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
        status: PostStatus.ACTIVE,
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
    cursor?: { createdAt: Date; id: string };
    excludeIds?: string[];
    excludeAuthorId?: string;
  }): Promise<FeedPostRecord[]> {
    const where: Prisma.PostWhereInput = {
      status: PostStatus.ACTIVE
    };
    if (input.excludeIds && input.excludeIds.length > 0) {
      where.id = { notIn: input.excludeIds };
    }
    if (input.excludeAuthorId) {
      where.authorId = { not: input.excludeAuthorId };
    }
    if (input.cursor) {
      where.OR = [
        { createdAt: { lt: input.cursor.createdAt } },
        {
          AND: [
            { createdAt: input.cursor.createdAt },
            { id: { lt: input.cursor.id } }
          ]
        }
      ];
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
    cursor?: { rank: bigint; insertedAt: Date; postId: string };
    take: number;
  }): Promise<HomeFeedRowRecord[]> {
    const where: Prisma.HomeFeedWhereInput = {
      ownerId: input.ownerId
    };

    if (input.cursor) {
      where.OR = [
        { rank: { lt: input.cursor.rank } },
        {
          AND: [
            { rank: input.cursor.rank },
            { insertedAt: { lt: input.cursor.insertedAt } }
          ]
        },
        {
          AND: [
            { rank: input.cursor.rank },
            { insertedAt: input.cursor.insertedAt },
            { postId: { lt: input.cursor.postId } }
          ]
        }
      ];
    }

    const rows = await this.db.homeFeed.findMany({
      where,
      orderBy: [{ rank: 'desc' }, { insertedAt: 'desc' }, { postId: 'desc' }],
      take: input.take
    });

    return rows.map(toHomeFeedRowRecord);
  }

  async listAdminPosts(input: {
    query?: string;
    status?: AdminPostStatus;
    cursor?: { createdAt: Date; id: string };
    take: number;
  }): Promise<AdminPostRecord[]> {
    const normalizedQuery = input.query?.trim();
    const items = await this.db.post.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(normalizedQuery
          ? {
              OR: [
                { id: { contains: normalizedQuery, mode: 'insensitive' } },
                { authorId: { contains: normalizedQuery, mode: 'insensitive' } },
                { body: { contains: normalizedQuery, mode: 'insensitive' } }
              ]
            }
          : {}),
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

  async createPost(input: {
    authorId: string;
    body: string;
    media: Array<{ type: string; key: string }>;
    repostOfId?: string | null;
  }): Promise<FeedPostRecord> {
    const post = await this.db.post.create({
      data: {
        authorId: input.authorId,
        body: input.body,
        media: input.media,
        repostOfId: input.repostOfId ?? null
      }
    });
    return toFeedPostRecord(post);
  }

  async findCommentById(id: string): Promise<FeedCommentRecord | null> {
    const comment = await this.db.comment.findUnique({ where: { id } });
    return comment ? toFeedCommentRecord(comment) : null;
  }

  async listCommentsByPost(input: {
    postId: string;
    cursor?: { createdAt: Date; id: string };
    take: number;
  }): Promise<FeedCommentRecord[]> {
    const comments = await this.db.comment.findMany({
      where: {
        postId: input.postId,
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

    return comments.map(toFeedCommentRecord);
  }

  async createComment(input: {
    postId: string;
    authorId: string;
    body: string;
  }): Promise<FeedCommentRecord> {
    const comment = await this.db.comment.create({
      data: {
        postId: input.postId,
        authorId: input.authorId,
        body: input.body
      }
    });
    return toFeedCommentRecord(comment);
  }

  async deleteCommentIfAuthor(input: { id: string; authorId: string }): Promise<boolean> {
    const result = await this.db.comment.deleteMany({
      where: {
        id: input.id,
        authorId: input.authorId
      }
    });
    return result.count > 0;
  }

  async upsertHomeFeedEntry(input: { ownerId: string; postId: string; insertedAt: Date }): Promise<void> {
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
        rank: seedHomeFeedRank(input.insertedAt),
        insertedAt: input.insertedAt
      },
      update: {}
    });
  }

  async listPostEngagementStats(postIds: string[]): Promise<PostEngagementStatsRecord[]> {
    if (postIds.length === 0) {
      return [];
    }

    const [likeCounts, commentCounts, repostCounts] = await Promise.all([
      this.db.like.groupBy({
        by: ['postId'],
        where: { postId: { in: postIds } },
        _count: { _all: true }
      }),
      this.db.comment.groupBy({
        by: ['postId'],
        where: { postId: { in: postIds } },
        _count: { _all: true }
      }),
      this.db.post.groupBy({
        by: ['repostOfId'],
        where: {
          repostOfId: { in: postIds },
          status: PostStatus.ACTIVE
        },
        _count: { _all: true }
      })
    ]);

    const stats = new Map<string, PostEngagementStatsRecord>(
      postIds.map((postId) => [
        postId,
        {
          postId,
          likeCount: 0,
          commentCount: 0,
          repostCount: 0
        }
      ])
    );

    for (const row of likeCounts) {
      const entry = stats.get(row.postId);
      if (entry) {
        entry.likeCount = row._count._all;
      }
    }

    for (const row of commentCounts) {
      const entry = stats.get(row.postId);
      if (entry) {
        entry.commentCount = row._count._all;
      }
    }

    for (const row of repostCounts) {
      if (!row.repostOfId) {
        continue;
      }
      const entry = stats.get(row.repostOfId);
      if (entry) {
        entry.repostCount = row._count._all;
      }
    }

    return postIds.map((postId) => stats.get(postId)!);
  }

  async updateHomeFeedRanks(input: {
    ownerId: string;
    entries: Array<{ postId: string; rank: bigint }>;
  }): Promise<void> {
    if (input.entries.length === 0) {
      return;
    }

    await Promise.all(
      input.entries.map((entry) =>
        this.db.homeFeed.update({
          where: {
            ownerId_postId: {
              ownerId: input.ownerId,
              postId: entry.postId
            }
          },
          data: {
            rank: entry.rank
          }
        })
      )
    );
  }

  async countPosts(input?: { status?: AdminPostStatus }): Promise<number> {
    return this.db.post.count({
      where: {
        ...(input?.status ? { status: input.status } : {})
      }
    });
  }

  async countPostsCreatedSince(since: Date, input?: { status?: AdminPostStatus }): Promise<number> {
    return this.db.post.count({
      where: {
        ...(input?.status ? { status: input.status } : {}),
        createdAt: { gte: since }
      }
    });
  }

  async updateAdminPostStatus(input: {
    postId: string;
    status: AdminPostStatus;
    hiddenReason?: AdminPostHiddenReason | null;
  }): Promise<AdminPostRecord | null> {
    try {
      const post = await this.db.post.update({
        where: { id: input.postId },
        data: {
          status: input.status,
          hiddenAt: input.status === 'HIDDEN' ? new Date() : null,
          hiddenReason:
            input.status === 'HIDDEN'
              ? (input.hiddenReason as PostHiddenReason | undefined) ?? PostHiddenReason.ADMIN_HIDDEN
              : null
        }
      });
      return toFeedPostRecord(post);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      throw error;
    }
  }

  async updateAdminPostsForAuthor(input: {
    authorId: string;
    status: AdminPostStatus;
    hiddenReason: AdminPostHiddenReason;
  }): Promise<string[]> {
    const posts = await this.db.post.findMany({
      where: {
        authorId: input.authorId,
        OR: [
          { status: PostStatus.ACTIVE },
          { hiddenReason: PostHiddenReason.USER_DEACTIVATED }
        ]
      },
      select: { id: true }
    });

    if (posts.length === 0) {
      return [];
    }

    await this.db.post.updateMany({
      where: {
        id: {
          in: posts.map((post) => post.id)
        }
      },
      data: {
        status: input.status,
        hiddenAt: input.status === 'HIDDEN' ? new Date() : null,
        hiddenReason:
          input.status === 'HIDDEN' ? (input.hiddenReason as PostHiddenReason) : null
      }
    });

    return posts.map((post) => post.id);
  }

  async restoreAuthorPostsHiddenByDeactivation(authorId: string): Promise<string[]> {
    const posts = await this.db.post.findMany({
      where: {
        authorId,
        status: PostStatus.HIDDEN,
        hiddenReason: PostHiddenReason.USER_DEACTIVATED
      },
      select: { id: true }
    });

    if (posts.length === 0) {
      return [];
    }

    await this.db.post.updateMany({
      where: {
        id: {
          in: posts.map((post) => post.id)
        }
      },
      data: {
        status: PostStatus.ACTIVE,
        hiddenAt: null,
        hiddenReason: null
      }
    });

    return posts.map((post) => post.id);
  }

  async countLikes(): Promise<number> {
    return this.db.like.count();
  }

  async countLikesForPost(postId: string): Promise<number> {
    return this.db.like.count({ where: { postId } });
  }

  async countCommentsForPost(postId: string): Promise<number> {
    return this.db.comment.count({ where: { postId } });
  }

  async countRepostsForPost(postId: string): Promise<number> {
    return this.db.post.count({
      where: {
        repostOfId: postId,
        status: PostStatus.ACTIVE
      }
    });
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

export interface FeedOutboxStatusCounts {
  pending: number;
  processing: number;
  published: number;
  failed: number;
  deadLetter: number;
}

export class PrismaFeedOutboxRelayStore {
  constructor(private readonly db: FeedPrismaDb = prisma) {}

  async listDue(limit: number, now = new Date()): Promise<PendingFeedOutboxEvent[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: {
        status: { in: [OutboxEventStatus.PENDING, OutboxEventStatus.FAILED] },
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
        status: { in: [OutboxEventStatus.PENDING, OutboxEventStatus.FAILED] }
      },
      data: {
        status: OutboxEventStatus.PROCESSING,
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
        status: OutboxEventStatus.PUBLISHED,
        publishedAt,
        lastError: null
      }
    });
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: OutboxEventStatus.FAILED,
        lastError: error.slice(0, 4000),
        nextAttemptAt,
        publishedAt: null,
        deadLetteredAt: null,
        deadLetterTopic: null
      }
    });
  }

  async markDeadLetter(
    id: string,
    error: string,
    input?: { deadLetteredAt?: Date; deadLetterTopic?: string | null }
  ): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: OutboxEventStatus.DEAD_LETTER,
        lastError: error.slice(0, 4000),
        deadLetteredAt: input?.deadLetteredAt ?? new Date(),
        deadLetterTopic: input?.deadLetterTopic ?? null,
        publishedAt: null
      }
    });
  }

  async countByStatus(): Promise<FeedOutboxStatusCounts> {
    const rows = await this.db.outboxEvent.groupBy({
      by: ['status'],
      _count: { _all: true }
    });

    const counts: FeedOutboxStatusCounts = {
      pending: 0,
      processing: 0,
      published: 0,
      failed: 0,
      deadLetter: 0
    };

    for (const row of rows) {
      switch (row.status) {
        case OutboxEventStatus.PENDING:
          counts.pending = row._count._all;
          break;
        case OutboxEventStatus.PROCESSING:
          counts.processing = row._count._all;
          break;
        case OutboxEventStatus.PUBLISHED:
          counts.published = row._count._all;
          break;
        case OutboxEventStatus.FAILED:
          counts.failed = row._count._all;
          break;
        case OutboxEventStatus.DEAD_LETTER:
          counts.deadLetter = row._count._all;
          break;
        default:
          break;
      }
    }

    return counts;
  }
}

export class PrismaFeedTransactionRunner implements FeedTransactionPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async run<T>(callback: (ports: FeedMutationPorts) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) =>
      callback({
        repository: new PrismaFeedRepository(tx),
        eventPublisher: new PrismaFeedOutboxEventPublisher(tx)
      })
    );
  }
}
