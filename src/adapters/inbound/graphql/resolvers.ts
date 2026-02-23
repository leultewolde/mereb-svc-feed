import type { IResolvers } from '@graphql-tools/utils';
import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import type { GraphQLContext } from '../../../context.js';
import { UnauthenticatedError } from '../../../domain/feed/errors.js';
import type { FeedApplicationModule } from '../../../application/feed/use-cases.js';

function parseAnyLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.NULL:
      return null;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.STRING:
    case Kind.ENUM:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.LIST:
      return ast.values.map((valueNode) => parseAnyLiteral(valueNode));
    case Kind.OBJECT: {
      const value: Record<string, unknown> = {};
      for (const field of ast.fields) {
        value[field.name.value] = parseAnyLiteral(field.value);
      }
      return value;
    }
    default:
      return null;
  }
}

const AnyScalar = new GraphQLScalarType({
  name: '_Any',
  description: 'Federation scalar that can represent any JSON value.',
  serialize: (value: unknown) => value,
  parseValue: (value: unknown) => value,
  parseLiteral: (ast) => parseAnyLiteral(ast)
});

function toGraphQLError(error: unknown): never {
  if (error instanceof UnauthenticatedError) {
    throw new Error(error.message);
  }
  throw error;
}

function hasResolvedMediaArray(value: unknown): value is { media: Array<{ type: string; url: string }> } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const media = (value as { media?: unknown }).media;
  return Array.isArray(media) && media.every((item) => item && typeof item === 'object' && 'url' in item);
}

export function createResolvers(
  feed: FeedApplicationModule
): IResolvers<Record<string, unknown>, GraphQLContext> {
  return {
    _Any: AnyScalar,
    _Entity: {
      __resolveType: (entity: unknown) => {
        if (entity && typeof entity === 'object') {
          if ('body' in entity || 'media' in entity) {
            return 'Post';
          }
          if ('id' in entity) {
            return 'User';
          }
        }
        return null;
      }
    },
    User: {
      __resolveReference: (ref: unknown) =>
        feed.queries.resolveUserReference((ref as { id: string }).id),
      posts: (_user: unknown, args: { after?: string; limit?: number }, ctx) => {
        const userId = String((_user as { id: string }).id);
        return feed.queries.userPosts(
          userId,
          { after: args.after, limit: args.limit },
          feed.helpers.toExecutionContext(ctx)
        );
      },
      liked: (_user: unknown, args: { postId: string }, ctx) =>
        feed.queries.userLikedPost(args.postId, feed.helpers.toExecutionContext(ctx))
    },
    Post: {
      __resolveReference: async (ref: unknown, _args: unknown, ctx: GraphQLContext) =>
        feed.queries.resolvePostReference(String((ref as { id: string }).id), feed.helpers.toExecutionContext(ctx)),
      author: (post: unknown) => {
        if (post && typeof post === 'object' && 'author' in post) {
          return (post as { author: { id: string } }).author;
        }
        return {
          __typename: 'User',
          id: (post as { authorId: string }).authorId
        };
      },
      media: async (post: unknown) => {
        if (hasResolvedMediaArray(post)) {
          return post.media;
        }
        return feed.queries.postMedia(post as { media?: unknown });
      },
      likeCount: (post: unknown) => {
        if (post && typeof post === 'object' && typeof (post as { likeCount?: unknown }).likeCount === 'number') {
          return (post as { likeCount: number }).likeCount;
        }
        return feed.queries.postLikeCount((post as { id: string }).id);
      },
      likedByMe: (post: unknown, _args: unknown, ctx: GraphQLContext) => {
        if (post && typeof post === 'object' && typeof (post as { likedByMe?: unknown }).likedByMe === 'boolean') {
          return (post as { likedByMe: boolean }).likedByMe;
        }
        return feed.queries.postLikedByViewer((post as { id: string }).id, feed.helpers.toExecutionContext(ctx));
      }
    },
    Query: {
      post: (_source: unknown, args: { id: string }, ctx) =>
        feed.queries.post(args.id, feed.helpers.toExecutionContext(ctx)),
      adminContentMetrics: () => feed.queries.adminContentMetrics(),
      adminRecentPosts: (_source: unknown, args: { limit?: number }, ctx) =>
        feed.queries.adminRecentPosts({ limit: args.limit }, feed.helpers.toExecutionContext(ctx)),
      _entities: async (
        _source: unknown,
        args: { representations: Array<{ __typename?: string; id?: string }> },
        ctx: GraphQLContext
      ) =>
        Promise.all(
          args.representations.map(async (representation) => {
            switch (representation.__typename) {
              case 'User':
                if (!representation.id) return null;
                return feed.queries.resolveUserReference(String(representation.id));
              case 'Post':
                if (!representation.id) return null;
                return feed.queries.resolvePostReference(String(representation.id), feed.helpers.toExecutionContext(ctx));
              default:
                return null;
            }
          })
        ),
      _service: () => ({ sdl: null }),
      feedHome: (_source: unknown, args: { after?: string; limit?: number }, ctx) =>
        feed.queries.feedHome({ after: args.after, limit: args.limit }, feed.helpers.toExecutionContext(ctx))
    },
    Mutation: {
      createPost: async (_source: unknown, args: { body: string; mediaKeys?: string[] }, ctx) => {
        try {
          return await feed.mutations.createPost(
            { body: args.body, mediaKeys: args.mediaKeys },
            feed.helpers.toExecutionContext(ctx)
          );
        } catch (error) {
          toGraphQLError(error);
        }
      },
      likePost: async (_source: unknown, args: { id: string }, ctx) => {
        try {
          return await feed.mutations.likePost({ id: args.id }, feed.helpers.toExecutionContext(ctx));
        } catch (error) {
          toGraphQLError(error);
        }
      },
      unlikePost: async (_source: unknown, args: { id: string }, ctx) => {
        try {
          return await feed.mutations.unlikePost({ id: args.id }, feed.helpers.toExecutionContext(ctx));
        } catch (error) {
          toGraphQLError(error);
        }
      }
    }
  } as IResolvers<Record<string, unknown>, GraphQLContext>;
}

