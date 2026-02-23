export class UnauthenticatedError extends Error {
  constructor(message = 'UNAUTHENTICATED') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

