import { Prisma, type Post } from '../../../../generated/client/index.js';
import { prisma } from '../../../prisma.js';
import type {
  FeedPostRecord,
  FeedRepositoryPort,
  HomeFeedRowRecord
} from '../../../application/feed/ports.js';

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
  async findPostById(id: string): Promise<FeedPostRecord | null> {
    const post = await prisma.post.findUnique({ where: { id } });
    return post ? toFeedPostRecord(post) : null;
  }

  async listPostsByAuthor(input: {
    authorId: string;
    cursor?: { createdAt: Date; id: string };
    take: number;
  }): Promise<FeedPostRecord[]> {
    const items = await prisma.post.findMany({
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

    const items = await prisma.post.findMany({
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

    const rows = await prisma.homeFeed.findMany({
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
    const post = await prisma.post.create({
      data: {
        authorId: input.authorId,
        body: input.body,
        media: input.media
      }
    });
    return toFeedPostRecord(post);
  }

  async upsertHomeFeedEntry(input: {
    ownerId: string;
    postId: string;
  }): Promise<void> {
    await prisma.homeFeed.upsert({
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
    return prisma.post.count();
  }

  async countPostsCreatedSince(since: Date): Promise<number> {
    return prisma.post.count({
      where: {
        createdAt: { gte: since }
      }
    });
  }

  async countLikes(): Promise<number> {
    return prisma.like.count();
  }

  async countLikesForPost(postId: string): Promise<number> {
    return prisma.like.count({ where: { postId } });
  }

  async isLikedByUser(postId: string, userId: string): Promise<boolean> {
    const like = await prisma.like.findUnique({
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
    await prisma.like.upsert({
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
    await prisma.like
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
