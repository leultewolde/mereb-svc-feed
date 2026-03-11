import type {
  AdminPostHiddenReason,
  AdminPostStatus,
  FeedMediaView,
  StoredPostMediaPayload
} from '../../domain/feed/post.js';

export interface FeedCursor {
  createdAt: Date;
  id: string;
}

export interface FeedPostRecord {
  id: string;
  authorId: string;
  body: string;
  media: unknown;
  visibility: string;
  status: AdminPostStatus;
  hiddenAt: Date | null;
  hiddenReason: AdminPostHiddenReason | null;
  createdAt: Date;
}

export type AdminPostRecord = FeedPostRecord;

export interface HomeFeedRowRecord {
  ownerId: string;
  postId: string;
  rank: number;
  insertedAt: Date;
}

export interface PostEdge {
  node: FeedPostView;
  cursor: string;
}

export interface PostConnection {
  edges: PostEdge[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

export interface AdminPostEdge {
  node: AdminPostView;
  cursor: string;
}

export interface AdminPostConnection {
  edges: AdminPostEdge[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

export interface FeedPostView {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  visibility: string;
  likeCount: number;
  likedByMe: boolean;
  media: FeedMediaView[];
  author: {
    id: string;
  };
}

export interface AdminPostView extends FeedPostView {
  status: AdminPostStatus;
  hiddenAt: string | null;
  hiddenReason: AdminPostHiddenReason | null;
}

export interface AdminContentMetrics {
  totalPosts: number;
  hiddenPosts: number;
  postsLast24h: number;
  totalLikes: number;
}

export interface FeedRepositoryPort {
  findPostById(id: string): Promise<FeedPostRecord | null>;
  findAdminPostById(id: string): Promise<AdminPostRecord | null>;
  listPostsByAuthor(input: {
    authorId: string;
    cursor?: FeedCursor;
    take: number;
  }): Promise<FeedPostRecord[]>;
  listRecentPosts(input: {
    take: number;
    excludeIds?: string[];
    excludeAuthorId?: string;
  }): Promise<FeedPostRecord[]>;
  listHomeFeed(input: {
    ownerId: string;
    cursor?: FeedCursor;
    take: number;
  }): Promise<HomeFeedRowRecord[]>;
  listAdminPosts(input: {
    query?: string;
    status?: AdminPostStatus;
    cursor?: FeedCursor;
    take: number;
  }): Promise<AdminPostRecord[]>;
  createPost(input: {
    authorId: string;
    body: string;
    media: StoredPostMediaPayload[];
  }): Promise<FeedPostRecord>;
  upsertHomeFeedEntry(input: {
    ownerId: string;
    postId: string;
  }): Promise<void>;
  countPosts(input?: { status?: AdminPostStatus }): Promise<number>;
  countPostsCreatedSince(since: Date, input?: { status?: AdminPostStatus }): Promise<number>;
  updateAdminPostStatus(input: {
    postId: string;
    status: AdminPostStatus;
    hiddenReason?: AdminPostHiddenReason | null;
  }): Promise<AdminPostRecord | null>;
  updateAdminPostsForAuthor(input: {
    authorId: string;
    status: AdminPostStatus;
    hiddenReason: AdminPostHiddenReason;
  }): Promise<string[]>;
  restoreAuthorPostsHiddenByDeactivation(authorId: string): Promise<string[]>;
  countLikes(): Promise<number>;
  countLikesForPost(postId: string): Promise<number>;
  isLikedByUser(postId: string, userId: string): Promise<boolean>;
  upsertLike(input: { postId: string; userId: string }): Promise<void>;
  deleteLikeIfExists(input: { postId: string; userId: string }): Promise<void>;
}

export interface PostCachePort {
  get(postId: string): Promise<FeedPostRecord | null>;
  set(post: FeedPostRecord): Promise<void>;
  invalidate(postId: string): Promise<void>;
}

export interface MediaUrlSignerPort {
  signMediaUrl(key: string): string;
}

export interface MediaAssetResolverPort {
  resolveOwnedReadyAsset(input: {
    assetId: string;
    userId: string;
  }): Promise<{ key: string }>;
}

export interface FeedEventPublisherPort {
  publishPostCreated(input: {
    postId: string;
    authorId: string;
    createdAt: Date;
    visibility: string;
  }): Promise<void>;
  publishPostLiked(input: {
    postId: string;
    userId: string;
  }): Promise<void>;
}

export interface FeedMutationPorts {
  repository: FeedRepositoryPort;
  eventPublisher: FeedEventPublisherPort;
}

export interface FeedTransactionPort {
  run<T>(callback: (ports: FeedMutationPorts) => Promise<T>): Promise<T>;
}
