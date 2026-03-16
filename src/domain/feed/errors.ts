export class UnauthenticatedError extends Error {
  constructor(message = 'UNAUTHENTICATED') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'FORBIDDEN') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class FeedPostNotFoundError extends Error {
  constructor(message = 'POST_NOT_FOUND') {
    super(message);
    this.name = 'FeedPostNotFoundError';
  }
}

export class InvalidMediaAssetError extends Error {
  constructor(message = 'INVALID_MEDIA_ASSET') {
    super(message);
    this.name = 'InvalidMediaAssetError';
  }
}

export class FeedCommentNotFoundError extends Error {
  constructor(message = 'COMMENT_NOT_FOUND') {
    super(message);
    this.name = 'FeedCommentNotFoundError';
  }
}
