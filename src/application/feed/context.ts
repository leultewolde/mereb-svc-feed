export interface AuthenticatedPrincipal {
  userId?: string;
  roles: string[];
}

export interface FeedExecutionContext {
  principal?: AuthenticatedPrincipal;
}
