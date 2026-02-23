import type { FeedMediaView, StoredPostMediaPayload } from '../../domain/feed/post.js';

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
  createdAt: Date;
}

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

export interface AdminContentMetrics {
  totalPosts: number;
  postsLast24h: number;
  totalLikes: number;
}

export interface FeedRepositoryPort {
  findPostById(id: string): Promise<FeedPostRecord | null>;
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
  createPost(input: {
    authorId: string;
    body: string;
    media: StoredPostMediaPayload[];
  }): Promise<FeedPostRecord>;
  upsertHomeFeedEntry(input: {
    ownerId: string;
    postId: string;
  }): Promise<void>;
  countPosts(): Promise<number>;
  countPostsCreatedSince(since: Date): Promise<number>;
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
