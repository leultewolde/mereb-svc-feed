export const FEED_EVENT_TOPICS = {
  postCreated: 'post.created.v1',
  postLiked: 'post.liked.v1'
} as const;

export interface FeedPostCreatedEventData {
  post_id: string;
  author_id: string;
  created_at: string;
  visibility: string;
}

export interface FeedPostLikedEventPayload {
  postId: string;
  userId: string;
}

