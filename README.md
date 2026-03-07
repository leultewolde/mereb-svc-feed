# svc-feed

`svc-feed` is the posts/likes/home-feed service. It exposes a federated GraphQL API and uses Postgres + Redis, with optional Kafka event publishing.

## API surface

- GraphQL endpoint: `POST /graphql`
- Health check: `GET /healthz`

Core GraphQL operations:

- queries: `feedHome`, `post`, `adminContentMetrics`, `adminRecentPosts`
- `User` extensions: `posts`, `liked(postId: ID!)`
- mutations: `createPost`, `likePost`, `unlikePost`

`createPost` supports both legacy keys and media asset IDs:

```graphql
mutation CreatePost($body: String!, $mediaAssetIds: [ID!]) {
  createPost(body: $body, mediaAssetIds: $mediaAssetIds) {
    id
    body
    media { type url }
  }
}
```

Media merge behavior in `createPost`:

- resolves each `mediaAssetId` through `svc-media`
- merges resolved keys with `mediaKeys`
- deduplicates by key while preserving insertion order

## Runtime notes

- Startup runs `prisma migrate deploy` before serving traffic.
- If Redis is unavailable, the service logs a warning and continues with cache disabled.
- Without Kafka config, event publishing falls back to no-op behavior.

## Environment

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | - | Postgres connection string. |
| `REDIS_URL` | yes | - | Redis connection string for post cache. |
| `OIDC_ISSUER` | yes | - | JWT issuer for auth context. |
| `OIDC_AUDIENCE` | no | - | JWT audience/client ID. |
| `MEDIA_SERVICE_URL` | no | `http://localhost:4003` | Used to resolve `mediaAssetIds` via `/assets/:id`. |
| `MEDIA_CDN_ORIGIN` | no | `https://cdn.example.com` | Base URL for signed media URLs. |
| `KAFKA_BROKERS` | no | - | Enables Kafka-backed worker/event paths when set. |
| `KAFKA_TOPIC_POST_CREATED` | no | `post.created.v1` | Topic for home-feed fanout consumer. |
| `KAFKA_HOME_FEED_GROUP_ID` | no | `svc-feed-home-feed` | Consumer group for home-feed fanout. |
| `PORT` | no | `4002` | HTTP listen port. |
| `HOST` | no | `0.0.0.0` | HTTP listen host. |

## Local development

```bash
pnpm --filter @services/svc-feed dev
pnpm --filter @services/svc-feed dev:outbox
pnpm --filter @services/svc-feed build
pnpm --filter @services/svc-feed start
```

## Tests

```bash
pnpm --filter @services/svc-feed test
pnpm --filter @services/svc-feed test:integration
pnpm --filter @services/svc-feed test:ci
```
