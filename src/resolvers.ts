import type {IResolvers} from '@graphql-tools/utils';
import {GraphQLScalarType, Kind, type ValueNode} from 'graphql';
import type {KafkaConfig} from 'kafkajs';
import {randomUUID} from 'node:crypto';
import {type Post, Prisma} from '../generated/client/index.js';
import {prisma} from './prisma.js';
import type {GraphQLContext} from './context.js';
import {getPostCache, invalidatePostCache, setPostCache} from './cache.js';
import {decodeCursor, encodeCursor} from './utils/cursor.js';
import {signMediaUrl} from '@mereb/shared-packages';
import {emitPostCreated, emitPostLiked} from './kafka.js';
import {createChildLogger} from './logger.js';

const logger = createChildLogger({module: 'resolvers'});
const MAX_LIMIT = 50;

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

function normalizeCreatedAt(input: unknown): string {
    if (input instanceof Date) {
        return input.toISOString();
    }
    if (typeof input === 'number') {
        return new Date(input).toISOString();
    }
    if (typeof input === 'string') {
        const asNumber = Number(input);
        if (!Number.isNaN(asNumber)) {
            return new Date(asNumber).toISOString();
        }
        const parsed = new Date(input);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    const fallback = new Date(input as string);
    if (!Number.isNaN(fallback.getTime())) {
        return fallback.toISOString();
    }
    return new Date().toISOString();
}

function mapMedia(media: unknown): Array<{ type: string; url: string }> {
    if (!Array.isArray(media)) {
        return [];
    }
    type MediaItem = { url?: string; key?: string; type?: string };
    return media
        .map((item): { type: string; url: string } | null => {
            if (item && typeof item === 'object') {
                const it = item as MediaItem;
                if (it.url) {
                    return {
                        type: it.type ?? 'image',
                        url: it.url
                    };
                }
                if (it.key) {
                    return {
                        type: it.type ?? 'image',
                        url: signMediaUrl(it.key)
                    };
                }
            }
            return null;
        })
        .filter(Boolean) as Array<{ type: string; url: string }>;
}

async function loadPost(postId: string, ctx: GraphQLContext) {
    const cached = await getPostCache(ctx.redis, postId);
    if (cached) {
        return cached;
    }

    const post = await prisma.post.findUnique({where: {id: postId}});
    if (!post) {
        return null;
    }

    await setPostCache(ctx.redis, post);
    return post;
}

async function countLikes(postId: string) {
    return prisma.like.count({where: {postId}});
}

async function isLikedByUser(postId: string, userId?: string) {
    if (!userId) {
        return false;
    }
    const like = await prisma.like.findUnique({
        where: {userId_postId: {userId, postId}}
    });
    return Boolean(like);
}

type PostRecord = Post & { media: unknown };

export function createResolvers(deps: { kafkaConfig?: KafkaConfig | null }) {
    const {kafkaConfig} = deps;
    const MIN_FEED_SIZE = 5;

    const asUser = (user: unknown): { id: string } => user as { id: string };
    const enrichPost = async (post: PostRecord, ctx: GraphQLContext) => ({
        ...post,
        createdAt: normalizeCreatedAt(post.createdAt),
        likeCount: await countLikes(post.id),
        likedByMe: await isLikedByUser(post.id, ctx.userId),
        media: mapMedia(post.media),
        author: {id: post.authorId}
    });

    const resolvePostReference = async (
        ref: { id: string },
        ctx: GraphQLContext
    ) => {
        const post = await loadPost(ref.id, ctx);
        if (!post) {
            return null;
        }
        return enrichPost(post as PostRecord, ctx);
    };

    const resolveUserReference = (ref: { id: string }) => ({
        id: String(ref.id)
    });

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
                resolveUserReference(ref as { id: string }),
            posts: async (
                user: unknown,
                args: { after?: string; limit?: number },
                ctx: GraphQLContext
            ) => {
                const limit = Math.min(args.limit ?? 20, MAX_LIMIT);
                const cursor = args.after ? decodeCursor(args.after) : null;
                const {id: userId} = asUser(user);

                const items = await prisma.post.findMany({
                    where: {
                        authorId: String(userId),
                        ...(cursor
                            ? {
                                OR: [
                                    {createdAt: {lt: cursor.createdAt}},
                                    {
                                        createdAt: cursor.createdAt,
                                        id: {lt: cursor.id}
                                    }
                                ]
                            }
                            : {})
                    },
                    orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
                    take: limit + 1
                });

                const edges = await Promise.all(
                    items.slice(0, limit).map(async (post: Post) => {
                        await setPostCache(ctx.redis, post);
                        const enriched = await enrichPost(post as PostRecord, ctx);
                        return {
                            cursor: encodeCursor(post.createdAt, post.id),
                            node: enriched
                        };
                    })
                );

                return {
                    edges,
                    pageInfo: {
                        endCursor: edges.at(-1)?.cursor ?? null,
                        hasNextPage: items.length > limit
                    }
                };
            },
            liked: async (
                user: unknown,
                {postId}: { postId: string },
                ctx: GraphQLContext
            ) => isLikedByUser(postId, ctx.userId)
        },
        Post: {
            __resolveReference: async (
                ref: unknown,
                _args: unknown,
                ctx: GraphQLContext
            ) => resolvePostReference(ref as { id: string }, ctx),
            author: (post: unknown) => ({
                __typename: 'User',
                id: (post as { authorId: string }).authorId
            }),
            media: (post: unknown) => mapMedia((post as PostRecord).media),
            likeCount: (post: unknown) => countLikes((post as PostRecord).id),
            likedByMe: (post: unknown, _args: unknown, ctx: GraphQLContext) =>
                isLikedByUser((post as PostRecord).id, ctx.userId)
        },
        Query: {
            post: async (
                _source: unknown,
                {id}: { id: string },
                ctx: GraphQLContext
            ) => loadPost(id, ctx),
            adminContentMetrics: async () => {
                const now = new Date();
                const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                const [totalPosts, postsLast24h, totalLikes] = await Promise.all([
                    prisma.post.count(),
                    prisma.post.count({where: {createdAt: {gte: last24h}}}),
                    prisma.like.count()
                ]);

                return {
                    totalPosts,
                    postsLast24h,
                    totalLikes
                };
            },
            adminRecentPosts: async (
                _source: unknown,
                args: { limit?: number },
                ctx: GraphQLContext
            ) => {
                const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
                const posts = await prisma.post.findMany({
                    orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
                    take: limit
                });

                return Promise.all(
                    posts.map(async (post) => {
                        await setPostCache(ctx.redis, post);
                        return enrichPost(post as PostRecord, ctx);
                    })
                );
            },
            _entities: async (
                _source: unknown,
                args: { representations: Array<{ __typename?: string; id?: string }> },
                ctx: GraphQLContext
            ) => {
                return await Promise.all(
                    args.representations.map(async (representation) => {
                        switch (representation.__typename) {
                            case 'User':
                                if (!representation.id) {
                                    return null;
                                }
                                return resolveUserReference({
                                    id: String(representation.id)
                                });
                            case 'Post':
                                if (!representation.id) {
                                    return null;
                                }
                                return resolvePostReference(
                                    {id: String(representation.id)},
                                    ctx
                                );
                            default:
                                return null;
                        }
                    })
                );
            },
            feedHome: async (
                _source: unknown,
                args: { after?: string; limit?: number },
                ctx: GraphQLContext
            ) => {
                const limit = Math.min(args.limit ?? 20, MAX_LIMIT);
                const cursor = args.after ? decodeCursor(args.after) : null;
                const ownerId = ctx.userId ?? 'anon';

                const where: Prisma.HomeFeedWhereInput = {
                    ownerId
                };

                if (cursor) {
                    where.AND = [
                        {
                            OR: [
                                {insertedAt: {lt: cursor.createdAt}},
                                {
                                    AND: [
                                        {insertedAt: cursor.createdAt},
                                        {postId: {lt: cursor.id}}
                                    ]
                                }
                            ]
                        }
                    ];
                }

                const rows = await prisma.homeFeed.findMany({
                    where,
                    orderBy: [{insertedAt: 'desc'}, {postId: 'desc'}],
                    take: limit + 1
                });

                if (rows.length === 0) {
                    const fallback = await prisma.post.findMany({
                        orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
                        take: limit + 1
                    });

                    const edges = await Promise.all(
                        fallback.slice(0, limit).map(async (post: Post) => {
                            await setPostCache(ctx.redis, post);
                            return {
                                cursor: encodeCursor(post.createdAt, post.id),
                                node: await enrichPost(post as PostRecord, ctx)
                            };
                        })
                    );

                    return {
                        edges,
                        pageInfo: {
                            endCursor: edges.at(-1)?.cursor ?? null,
                            hasNextPage: fallback.length > limit
                        }
                    };
                }
                type HomeFeedRow = { postId: string; insertedAt: Date };
                const edges = await Promise.all(
                    rows.slice(0, limit).map(async (row: HomeFeedRow) => {
                        const post = await loadPost(row.postId, ctx);
                        if (!post) {
                            return null;
                        }
                        return {
                            cursor: encodeCursor(row.insertedAt, row.postId),
                            node: await enrichPost(post as PostRecord, ctx)
                        };
                    })
                );

                const filteredEdges = edges.filter(Boolean) as Array<{
                    cursor: string;
                    node: Awaited<ReturnType<typeof enrichPost>>;
                }>;

                // If the feed is too sparse or dominated by a single author, blend in recent posts
                const uniqueAuthors = new Set(
                    filteredEdges.map((edge) => edge.node.author.id)
                );
                const needsSupplement =
                    filteredEdges.length < MIN_FEED_SIZE ||
                    uniqueAuthors.size <= 1;

                let supplementedEdges = filteredEdges;
                if (needsSupplement) {
                    const existingIds = new Set(
                        filteredEdges.map((edge) => edge.node.id)
                    );
                    const supplementCount = MIN_FEED_SIZE - filteredEdges.length + 3;
                    const recentExtras = await prisma.post.findMany({
                        where: {
                            id: {notIn: Array.from(existingIds)},
                            authorId: ctx.userId
                                ? {not: ctx.userId}
                                : undefined
                        },
                        orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
                        take: supplementCount
                    });

                    const extraEdges = await Promise.all(
                        recentExtras.map(async (post: Post) => ({
                            cursor: encodeCursor(post.createdAt, post.id),
                            node: await enrichPost(post as PostRecord, ctx)
                        }))
                    );

                    supplementedEdges = [...filteredEdges, ...extraEdges];
                }

                return {
                    edges: supplementedEdges,
                    pageInfo: {
                        endCursor: supplementedEdges.at(-1)?.cursor ?? null,
                        hasNextPage: rows.length > limit
                    }
                };
            }
        },
        Mutation: {
            createPost: async (
                _source: unknown,
                args: { body: string; mediaKeys?: string[] },
                ctx: GraphQLContext
            ) => {
                if (!ctx.userId) {
                    throw new Error('UNAUTHENTICATED');
                }

                const mediaPayload = (args.mediaKeys ?? []).map((key) => ({
                    type: key.endsWith('.mp4') ? 'video' : 'image',
                    key
                }));

                const post = await prisma.post.create({
                    data: {
                        authorId: ctx.userId,
                        body: args.body,
                        media: mediaPayload
                    }
                });

                await prisma.homeFeed.upsert({
                    where: {ownerId_postId: {ownerId: ctx.userId, postId: post.id}},
                    create: {
                        ownerId: ctx.userId,
                        postId: post.id,
                        rank: 0
                    },
                    update: {}
                });

                await prisma.homeFeed.upsert({
                    where: {ownerId_postId: {ownerId: 'anon', postId: post.id}},
                    create: {
                        ownerId: 'anon',
                        postId: post.id,
                        rank: 0
                    },
                    update: {}
                });

                await setPostCache(ctx.redis, post);

                if (kafkaConfig) {
                    try {
                        await emitPostCreated(kafkaConfig, {
                            event_id: randomUUID(),
                            event_type: 'post.created.v1',
                            occurred_at: new Date().toISOString(),
                            producer: 'svc-feed',
                            data: {
                                post_id: post.id,
                                author_id: post.authorId,
                                created_at: post.createdAt.toISOString(),
                                visibility: post.visibility
                            }
                        });
                    } catch (error) {
                        logger.error({err: error}, 'Failed to emit post.created event');
                    }
                }

                return {
                    ...post,
                    likeCount: 0,
                    likedByMe: true,
                    media: mediaPayload.map((item) => ({
                        type: item.type,
                        url: signMediaUrl(item.key)
                    }))
                };
            },
            likePost: async (
                _source: unknown,
                {id}: { id: string },
                ctx: GraphQLContext
            ) => {
                if (!ctx.userId) {
                    throw new Error('UNAUTHENTICATED');
                }

                await prisma.like.upsert({
                    where: {userId_postId: {userId: ctx.userId, postId: id}},
                    update: {},
                    create: {userId: ctx.userId, postId: id}
                });

                await invalidatePostCache(ctx.redis, id);

                if (kafkaConfig) {
                    try {
                        await emitPostLiked(kafkaConfig, {
                            event_id: randomUUID(),
                            event_type: 'post.liked.v1',
                            occurred_at: new Date().toISOString(),
                            producer: 'svc-feed',
                            postId: id,
                            userId: ctx.userId
                        });
                    } catch (error) {
                        logger.error({err: error}, 'Failed to emit post.liked event');
                    }
                }

                return true;
            },
            unlikePost: async (
                _source: unknown,
                {id}: { id: string },
                ctx: GraphQLContext
            ) => {
                if (!ctx.userId) {
                    throw new Error('UNAUTHENTICATED');
                }

                await prisma.like
                    .delete({where: {userId_postId: {userId: ctx.userId, postId: id}}})
                    .catch(() => undefined);

                await invalidatePostCache(ctx.redis, id);
                return true;
            }
        }
    } as IResolvers<Record<string, unknown>, GraphQLContext>;
}
