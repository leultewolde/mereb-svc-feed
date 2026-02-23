import type { GraphQLContext } from '../../context.js';
import { decodeCursor, encodeCursor } from '../../utils/cursor.js';
import { UnauthenticatedError } from '../../domain/feed/errors.js';
import { postCreatedEvent, postLikedEvent } from '../../domain/feed/events.js';
import {
  buildStoredPostMediaPayload,
  normalizeCreatedAt,
  type FeedMediaRecord,
  type FeedMediaView
} from '../../domain/feed/post.js';
import type { FeedExecutionContext } from './context.js';
import type {
  AdminContentMetrics,
  FeedEventPublisherPort,
  FeedMutationPorts,
  FeedPostRecord,
  FeedPostView,
  FeedRepositoryPort,
  FeedTransactionPort,
  MediaUrlSignerPort,
  PostCachePort,
  PostConnection
} from './ports.js';

const MAX_LIMIT = 50;
const MIN_FEED_SIZE = 5;

function toExecutionContext(ctx: GraphQLContext): FeedExecutionContext {
  return ctx.userId ? { principal: { userId: ctx.userId } } : {};
}

function requireAuth(ctx: FeedExecutionContext): string {
  const userId = ctx.principal?.userId;
  if (!userId) {
    throw new UnauthenticatedError();
  }
  return userId;
}

function mapMedia(
  media: unknown,
  mediaUrlSigner: MediaUrlSignerPort
): FeedMediaView[] {
  if (!Array.isArray(media)) {
    return [];
  }

  return media
    .map((item): FeedMediaView | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const candidate = item as FeedMediaRecord;
      if (candidate.url) {
        return {
          type: candidate.type ?? 'image',
          url: candidate.url
        };
      }
      if (candidate.key) {
        return {
          type: candidate.type ?? 'image',
          url: mediaUrlSigner.signMediaUrl(candidate.key)
        };
      }
      return null;
    })
    .filter(Boolean) as FeedMediaView[];
}

interface FeedDeps {
  repository: FeedRepositoryPort;
  postCache: PostCachePort;
  mediaUrlSigner: MediaUrlSignerPort;
  eventPublisher: FeedEventPublisherPort;
  transactionRunner?: FeedTransactionPort;
}

type PostLikeViewerContext = Pick<FeedExecutionContext, 'principal'>;

function getDefaultMutationPorts(deps: FeedDeps): FeedMutationPorts {
  return {
    repository: deps.repository,
    eventPublisher: deps.eventPublisher
  };
}

async function runInMutationTransaction<T>(
  deps: FeedDeps,
  callback: (ports: FeedMutationPorts) => Promise<T>
): Promise<T> {
  if (!deps.transactionRunner) {
    return callback(getDefaultMutationPorts(deps));
  }
  return deps.transactionRunner.run(callback);
}

async function enrichPost(
  deps: FeedDeps,
  post: FeedPostRecord,
  ctx: PostLikeViewerContext
): Promise<FeedPostView> {
  const [likeCount, likedByMe] = await Promise.all([
    deps.repository.countLikesForPost(post.id),
    ctx.principal?.userId
      ? deps.repository.isLikedByUser(post.id, ctx.principal.userId)
      : Promise.resolve(false)
  ]);

  return {
    id: post.id,
    authorId: post.authorId,
    body: post.body,
    createdAt: normalizeCreatedAt(post.createdAt),
    visibility: post.visibility,
    likeCount,
    likedByMe,
    media: mapMedia(post.media, deps.mediaUrlSigner),
    author: {
      id: post.authorId
    }
  };
}

async function loadPostWithCache(deps: FeedDeps, postId: string): Promise<FeedPostRecord | null> {
  const cached = await deps.postCache.get(postId);
  if (cached) {
    return cached;
  }
  const post = await deps.repository.findPostById(postId);
  if (!post) {
    return null;
  }
  await deps.postCache.set(post);
  return post;
}

async function toPostConnection(
  deps: FeedDeps,
  posts: FeedPostRecord[],
  limit: number,
  ctx: FeedExecutionContext
): Promise<PostConnection> {
  const edges = await Promise.all(
    posts.slice(0, limit).map(async (post) => {
      await deps.postCache.set(post);
      return {
        cursor: encodeCursor(post.createdAt, post.id),
        node: await enrichPost(deps, post, ctx)
      };
    })
  );

  return {
    edges,
    pageInfo: {
      endCursor: edges.at(-1)?.cursor ?? null,
      hasNextPage: posts.length > limit
    }
  };
}

export class FeedQueries {
  constructor(private readonly deps: FeedDeps) {}

  async post(id: string, ctx: FeedExecutionContext): Promise<FeedPostView | null> {
    const post = await loadPostWithCache(this.deps, id);
    if (!post) {
      return null;
    }
    return enrichPost(this.deps, post, ctx);
  }

  async resolvePostReference(id: string, ctx: FeedExecutionContext): Promise<FeedPostView | null> {
    return this.post(id, ctx);
  }

  resolveUserReference(id: string): { id: string } {
    return { id: String(id) };
  }

  async userPosts(
    userId: string,
    args: { after?: string; limit?: number },
    ctx: FeedExecutionContext
  ): Promise<PostConnection> {
    const limit = Math.min(args.limit ?? 20, MAX_LIMIT);
    const cursor = args.after ? decodeCursor(args.after) : undefined;
    const posts = await this.deps.repository.listPostsByAuthor({
      authorId: String(userId),
      cursor,
      take: limit + 1
    });
    return toPostConnection(this.deps, posts, limit, ctx);
  }

  async userLikedPost(
    postId: string,
    ctx: FeedExecutionContext
  ): Promise<boolean> {
    const viewerId = ctx.principal?.userId;
    if (!viewerId) {
      return false;
    }
    return this.deps.repository.isLikedByUser(postId, viewerId);
  }

  async adminContentMetrics(): Promise<AdminContentMetrics> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [totalPosts, postsLast24h, totalLikes] = await Promise.all([
      this.deps.repository.countPosts(),
      this.deps.repository.countPostsCreatedSince(last24h),
      this.deps.repository.countLikes()
    ]);

    return {
      totalPosts,
      postsLast24h,
      totalLikes
    };
  }

  async adminRecentPosts(
    args: { limit?: number },
    ctx: FeedExecutionContext
  ): Promise<FeedPostView[]> {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const posts = await this.deps.repository.listRecentPosts({ take: limit });
    await Promise.all(posts.map((post) => this.deps.postCache.set(post)));
    return Promise.all(posts.map((post) => enrichPost(this.deps, post, ctx)));
  }

  async feedHome(
    args: { after?: string; limit?: number },
    ctx: FeedExecutionContext
  ): Promise<PostConnection> {
    const limit = Math.min(args.limit ?? 20, MAX_LIMIT);
    const cursor = args.after ? decodeCursor(args.after) : undefined;
    const ownerId = ctx.principal?.userId ?? 'anon';

    const rows = await this.deps.repository.listHomeFeed({
      ownerId,
      cursor,
      take: limit + 1
    });

    if (rows.length === 0) {
      const fallback = await this.deps.repository.listRecentPosts({ take: limit + 1 });
      return toPostConnection(this.deps, fallback, limit, ctx);
    }

    const rowEdges = await Promise.all(
      rows.slice(0, limit).map(async (row) => {
        const post = await loadPostWithCache(this.deps, row.postId);
        if (!post) {
          return null;
        }

        return {
          cursor: encodeCursor(row.insertedAt, row.postId),
          node: await enrichPost(this.deps, post, ctx)
        };
      })
    );

    const filteredEdges = rowEdges.filter(Boolean) as PostConnection['edges'];
    const uniqueAuthors = new Set(filteredEdges.map((edge) => edge.node.author.id));
    const needsSupplement =
      filteredEdges.length < MIN_FEED_SIZE || uniqueAuthors.size <= 1;

    let supplementedEdges = filteredEdges;
    if (needsSupplement) {
      const existingIds = filteredEdges.map((edge) => edge.node.id);
      const supplementCount = MIN_FEED_SIZE - filteredEdges.length + 3;
      const extras = await this.deps.repository.listRecentPosts({
        take: supplementCount,
        excludeIds: existingIds,
        excludeAuthorId: ctx.principal?.userId
      });

      const extraEdges = await Promise.all(
        extras.map(async (post) => ({
          cursor: encodeCursor(post.createdAt, post.id),
          node: await enrichPost(this.deps, post, ctx)
        }))
      );

      supplementedEdges = [...filteredEdges, ...extraEdges];
    }

    return {
      edges: supplementedEdges,
      pageInfo: {
        endCursor: supplementedEdges.at(-1)?.cursor ?? null,
        hasNextPage: rows.length > limit
      }
    };
  }

  async postLikeCount(postId: string): Promise<number> {
    return this.deps.repository.countLikesForPost(postId);
  }

  async postLikedByViewer(postId: string, ctx: FeedExecutionContext): Promise<boolean> {
    const viewerId = ctx.principal?.userId;
    if (!viewerId) {
      return false;
    }
    return this.deps.repository.isLikedByUser(postId, viewerId);
  }

  async postMedia(post: { media?: unknown }): Promise<FeedMediaView[]> {
    return mapMedia(post.media, this.deps.mediaUrlSigner);
  }
}

export class FeedMutations {
  constructor(private readonly deps: FeedDeps) {}

  async createPost(
    input: { body: string; mediaKeys?: string[] },
    ctx: FeedExecutionContext
  ): Promise<FeedPostView> {
    const userId = requireAuth(ctx);
    const mediaPayload = buildStoredPostMediaPayload(input.mediaKeys);
    const post = await runInMutationTransaction(this.deps, async (ports) => {
      const created = await ports.repository.createPost({
        authorId: userId,
        body: input.body,
        media: mediaPayload
      });

      await Promise.all([
        ports.repository.upsertHomeFeedEntry({ ownerId: userId, postId: created.id }),
        ports.repository.upsertHomeFeedEntry({ ownerId: 'anon', postId: created.id })
      ]);

      const event = postCreatedEvent({
        postId: created.id,
        authorId: created.authorId,
        createdAt: created.createdAt,
        visibility: created.visibility
      });
      await ports.eventPublisher.publishPostCreated({
        postId: event.payload.postId,
        authorId: event.payload.authorId,
        createdAt: event.payload.createdAt,
        visibility: event.payload.visibility
      });

      return created;
    });

    await this.deps.postCache.set(post);

    return {
      id: post.id,
      authorId: post.authorId,
      body: post.body,
      createdAt: normalizeCreatedAt(post.createdAt),
      visibility: post.visibility,
      likeCount: 0,
      likedByMe: true,
      media: mapMedia(mediaPayload, this.deps.mediaUrlSigner),
      author: {
        id: post.authorId
      }
    };
  }

  async likePost(input: { id: string }, ctx: FeedExecutionContext): Promise<boolean> {
    const userId = requireAuth(ctx);
    await runInMutationTransaction(this.deps, async (ports) => {
      await ports.repository.upsertLike({
        postId: input.id,
        userId
      });

      const event = postLikedEvent({
        postId: input.id,
        userId
      });
      await ports.eventPublisher.publishPostLiked({
        postId: event.payload.postId,
        userId: event.payload.userId
      });
    });
    await this.deps.postCache.invalidate(input.id);

    return true;
  }

  async unlikePost(input: { id: string }, ctx: FeedExecutionContext): Promise<boolean> {
    const userId = requireAuth(ctx);
    await this.deps.repository.deleteLikeIfExists({
      postId: input.id,
      userId
    });
    await this.deps.postCache.invalidate(input.id);
    return true;
  }
}

export interface FeedApplicationModule {
  queries: FeedQueries;
  mutations: FeedMutations;
  helpers: {
    toExecutionContext: (ctx: GraphQLContext) => FeedExecutionContext;
  };
}

export function createFeedApplicationModule(deps: FeedDeps): FeedApplicationModule {
  return {
    queries: new FeedQueries(deps),
    mutations: new FeedMutations(deps),
    helpers: {
      toExecutionContext
    }
  };
}
