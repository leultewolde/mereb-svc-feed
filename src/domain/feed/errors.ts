export class UnauthenticatedError extends Error {
  constructor(message = 'UNAUTHENTICATED') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class InvalidMediaAssetError extends Error {
  constructor(message = 'INVALID_MEDIA_ASSET') {
    super(message);
    this.name = 'InvalidMediaAssetError';
  }
}
