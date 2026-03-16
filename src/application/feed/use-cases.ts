import type { GraphQLContext } from '../../context.js';
import { decodeCursor, encodeCursor } from '../../utils/cursor.js';
import {
  FeedCommentNotFoundError,
  FeedPostNotFoundError,
  ForbiddenError,
  InvalidMediaAssetError,
  UnauthenticatedError
} from '../../domain/feed/errors.js';
import { postCreatedEvent, postLikedEvent } from '../../domain/feed/events.js';
import {
  normalizeCreatedAt,
  type AdminPostStatus,
  buildStoredPostMediaPayload,
  type FeedMediaRecord,
  type FeedMediaView
} from '../../domain/feed/post.js';
import type { FeedExecutionContext } from './context.js';
import type {
  AdminContentMetrics,
  AdminPostConnection,
  AdminPostRecord,
  AdminPostView,
  CommentConnection,
  FeedCommentRecord,
  FeedCommentView,
  FeedEventPublisherPort,
  FeedMutationPorts,
  FeedPostRecord,
  FeedPostReferenceView,
  FeedPostView,
  FeedRepositoryPort,
  FeedTransactionPort,
  MediaAssetResolverPort,
  MediaUrlSignerPort,
  PostCachePort,
  PostConnection
} from './ports.js';
import { hasAdminReadAccess, hasFullAdminAccess } from '@mereb/shared-packages';

const MAX_LIMIT = 50;
const MIN_FEED_SIZE = 5;

function toExecutionContext(ctx: GraphQLContext): FeedExecutionContext {
  return {
    principal:
      ctx.userId || (ctx.roles?.length ?? 0) > 0
        ? { userId: ctx.userId, roles: ctx.roles ?? [] }
        : undefined
  };
}

function requireAuth(ctx: FeedExecutionContext): string {
  const userId = ctx.principal?.userId;
  if (!userId) {
    throw new UnauthenticatedError();
  }
  return userId;
}

function requireAdminReadAccess(ctx: FeedExecutionContext): void {
  if (!hasAdminReadAccess(ctx.principal?.roles)) {
    throw new ForbiddenError();
  }
}

function requireFullAdminAccess(ctx: FeedExecutionContext): void {
  if (!hasFullAdminAccess(ctx.principal?.roles)) {
    throw new ForbiddenError();
  }
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
  mediaAssetResolver?: MediaAssetResolverPort;
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

async function enrichPostReference(
  deps: FeedDeps,
  post: FeedPostRecord,
  ctx: PostLikeViewerContext
): Promise<FeedPostReferenceView> {
  const [likeCount, likedByMe, commentCount, repostCount] = await Promise.all([
    deps.repository.countLikesForPost(post.id),
    ctx.principal?.userId
      ? deps.repository.isLikedByUser(post.id, ctx.principal.userId)
      : Promise.resolve(false),
    deps.repository.countCommentsForPost(post.id),
    deps.repository.countRepostsForPost(post.id)
  ]);

  return {
    id: post.id,
    authorId: post.authorId,
    body: post.body,
    createdAt: normalizeCreatedAt(post.createdAt),
    visibility: post.visibility,
    likeCount,
    likedByMe,
    commentCount,
    repostCount,
    media: mapMedia(post.media, deps.mediaUrlSigner),
    author: {
      id: post.authorId
    }
  };
}

async function enrichPost(
  deps: FeedDeps,
  post: FeedPostRecord,
  ctx: PostLikeViewerContext
): Promise<FeedPostView> {
  const [base, repostOfPost] = await Promise.all([
    enrichPostReference(deps, post, ctx),
    post.repostOfId ? loadPostWithCache(deps, post.repostOfId) : Promise.resolve(null)
  ]);

  return {
    ...base,
    repostOf: repostOfPost ? await enrichPostReference(deps, repostOfPost, ctx) : null
  };
}

async function enrichAdminPost(
  deps: FeedDeps,
  post: AdminPostRecord,
  ctx: PostLikeViewerContext
): Promise<AdminPostView> {
  const base = await enrichPost(deps, post, ctx);
  return {
    ...base,
    status: post.status,
    hiddenAt: post.hiddenAt ? normalizeCreatedAt(post.hiddenAt) : null,
    hiddenReason: post.hiddenReason
  };
}

function toCommentView(comment: FeedCommentRecord): FeedCommentView {
  return {
    id: comment.id,
    postId: comment.postId,
    body: comment.body,
    createdAt: normalizeCreatedAt(comment.createdAt),
    author: {
      id: comment.authorId
    }
  };
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

async function toAdminPostConnection(
  deps: FeedDeps,
  posts: AdminPostRecord[],
  limit: number,
  ctx: FeedExecutionContext
): Promise<AdminPostConnection> {
  const edges = await Promise.all(
    posts.slice(0, limit).map(async (post) => ({
      cursor: encodeCursor(post.createdAt, post.id),
      node: await enrichAdminPost(deps, post, ctx)
    }))
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

  async userLikedPost(postId: string, ctx: FeedExecutionContext): Promise<boolean> {
    const viewerId = ctx.principal?.userId;
    if (!viewerId) {
      return false;
    }
    return this.deps.repository.isLikedByUser(postId, viewerId);
  }

  async adminContentMetrics(ctx: FeedExecutionContext): Promise<AdminContentMetrics> {
    requireAdminReadAccess(ctx);
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [totalPosts, hiddenPosts, postsLast24h, totalLikes] = await Promise.all([
      this.deps.repository.countPosts(),
      this.deps.repository.countPosts({ status: 'HIDDEN' }),
      this.deps.repository.countPostsCreatedSince(last24h),
      this.deps.repository.countLikes()
    ]);

    return {
      totalPosts,
      hiddenPosts,
      postsLast24h,
      totalLikes
    };
  }

  async adminRecentPosts(
    args: { limit?: number },
    ctx: FeedExecutionContext
  ): Promise<AdminPostView[]> {
    requireAdminReadAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const posts = await this.deps.repository.listAdminPosts({ take: limit });
    return Promise.all(posts.map((post) => enrichAdminPost(this.deps, post, ctx)));
  }

  async adminPosts(
    args: { query?: string; status?: AdminPostStatus; after?: string; limit?: number },
    ctx: FeedExecutionContext
  ): Promise<AdminPostConnection> {
    requireAdminReadAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_LIMIT);
    const cursor = args.after ? decodeCursor(args.after) : undefined;
    const posts = await this.deps.repository.listAdminPosts({
      query: args.query?.trim() || undefined,
      status: args.status,
      cursor,
      take: limit + 1
    });
    return toAdminPostConnection(this.deps, posts, limit, ctx);
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

  async postCommentCount(postId: string): Promise<number> {
    return this.deps.repository.countCommentsForPost(postId);
  }

  async postRepostCount(postId: string): Promise<number> {
    return this.deps.repository.countRepostsForPost(postId);
  }

  async postRepostOf(
    post: { repostOf?: FeedPostReferenceView | null; repostOfId?: string | null },
    ctx: FeedExecutionContext
  ): Promise<FeedPostReferenceView | null> {
    if (post.repostOf !== undefined) {
      return post.repostOf ?? null;
    }
    if (!post.repostOfId) {
      return null;
    }
    const repostOf = await loadPostWithCache(this.deps, post.repostOfId);
    if (!repostOf) {
      return null;
    }
    return enrichPostReference(this.deps, repostOf, ctx);
  }

  async postComments(
    postId: string,
    args: { after?: string; limit?: number }
  ): Promise<CommentConnection> {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_LIMIT);
    const cursor = args.after ? decodeCursor(args.after) : undefined;
    const comments = await this.deps.repository.listCommentsByPost({
      postId,
      cursor,
      take: limit + 1
    });
    const edges = comments.slice(0, limit).map((comment) => ({
      cursor: encodeCursor(comment.createdAt, comment.id),
      node: toCommentView(comment)
    }));

    return {
      edges,
      pageInfo: {
        endCursor: edges.at(-1)?.cursor ?? null,
        hasNextPage: comments.length > limit
      }
    };
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

  private async resolveMediaKeys(input: {
    mediaKeys?: string[];
    mediaAssetIds?: string[];
  }, userId: string): Promise<string[]> {
    const keySet = new Set(input.mediaKeys ?? []);
    const mediaAssetIds = input.mediaAssetIds ?? [];

    if (mediaAssetIds.length === 0) {
      return Array.from(keySet);
    }

    if (!this.deps.mediaAssetResolver) {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_RESOLVER');
    }

    for (const assetId of mediaAssetIds) {
      const resolved = await this.deps.mediaAssetResolver.resolveOwnedReadyAsset({
        assetId,
        userId
      });
      keySet.add(resolved.key);
    }

    return Array.from(keySet);
  }

  async createPost(
    input: { body: string; mediaKeys?: string[]; mediaAssetIds?: string[] },
    ctx: FeedExecutionContext
  ): Promise<FeedPostView> {
    const userId = requireAuth(ctx);
    const mediaKeys = await this.resolveMediaKeys(input, userId);
    const mediaPayload = buildStoredPostMediaPayload(mediaKeys);
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
      likedByMe: false,
      commentCount: 0,
      repostCount: 0,
      repostOf: null,
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

  async createComment(
    input: { postId: string; body: string },
    ctx: FeedExecutionContext
  ): Promise<FeedCommentView> {
    const userId = requireAuth(ctx);
    const trimmedBody = input.body.trim();
    if (!trimmedBody) {
      throw new Error('COMMENT_BODY_REQUIRED');
    }

    const post = await loadPostWithCache(this.deps, input.postId);
    if (!post) {
      throw new FeedPostNotFoundError();
    }

    const comment = await this.deps.repository.createComment({
      postId: input.postId,
      authorId: userId,
      body: trimmedBody
    });

    return toCommentView(comment);
  }

  async deleteComment(input: { id: string }, ctx: FeedExecutionContext): Promise<boolean> {
    const userId = requireAuth(ctx);
    const comment = await this.deps.repository.findCommentById(input.id);
    if (!comment) {
      throw new FeedCommentNotFoundError();
    }
    if (comment.authorId !== userId) {
      throw new ForbiddenError();
    }
    return this.deps.repository.deleteCommentIfAuthor({
      id: input.id,
      authorId: userId
    });
  }

  async repostPost(
    input: { id: string; body?: string | null },
    ctx: FeedExecutionContext
  ): Promise<FeedPostView> {
    const userId = requireAuth(ctx);
    const target = await loadPostWithCache(this.deps, input.id);
    if (!target) {
      throw new FeedPostNotFoundError();
    }

    const rootPostId = target.repostOfId ?? target.id;
    const rootPost = rootPostId === target.id ? target : await loadPostWithCache(this.deps, rootPostId);
    if (!rootPost) {
      throw new FeedPostNotFoundError();
    }

    const repost = await runInMutationTransaction(this.deps, async (ports) => {
      const created = await ports.repository.createPost({
        authorId: userId,
        body: input.body?.trim() ?? '',
        media: [],
        repostOfId: rootPost.id
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

    await this.deps.postCache.set(repost);
    return enrichPost(this.deps, repost, ctx);
  }

  async adminHidePost(input: { postId: string }, ctx: FeedExecutionContext): Promise<AdminPostView> {
    requireFullAdminAccess(ctx);
    const updated = await this.deps.repository.updateAdminPostStatus({
      postId: input.postId,
      status: 'HIDDEN',
      hiddenReason: 'ADMIN_HIDDEN'
    });
    if (!updated) {
      throw new FeedPostNotFoundError();
    }
    await this.deps.postCache.invalidate(input.postId);
    return enrichAdminPost(this.deps, updated, ctx);
  }

  async adminRestorePost(input: { postId: string }, ctx: FeedExecutionContext): Promise<AdminPostView> {
    requireFullAdminAccess(ctx);
    const updated = await this.deps.repository.updateAdminPostStatus({
      postId: input.postId,
      status: 'ACTIVE',
      hiddenReason: null
    });
    if (!updated) {
      throw new FeedPostNotFoundError();
    }
    await this.deps.postCache.invalidate(input.postId);
    return enrichAdminPost(this.deps, updated, ctx);
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
