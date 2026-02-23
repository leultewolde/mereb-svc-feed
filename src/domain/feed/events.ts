export interface PostCreatedDomainEvent {
  type: 'PostCreated';
  occurredAt: Date;
  payload: {
    postId: string;
    authorId: string;
    createdAt: Date;
    visibility: string;
  };
}

export interface PostLikedDomainEvent {
  type: 'PostLiked';
  occurredAt: Date;
  payload: {
    postId: string;
    userId: string;
  };
}

export function postCreatedEvent(input: {
  postId: string;
  authorId: string;
  createdAt: Date;
  visibility: string;
}): PostCreatedDomainEvent {
  return {
    type: 'PostCreated',
    occurredAt: new Date(),
    payload: input
  };
}

export function postLikedEvent(input: {
  postId: string;
  userId: string;
}): PostLikedDomainEvent {
  return {
    type: 'PostLiked',
    occurredAt: new Date(),
    payload: input
  };
}

