export interface AuthenticatedPrincipal {
  userId: string;
}

export interface FeedExecutionContext {
  principal?: AuthenticatedPrincipal;
}

