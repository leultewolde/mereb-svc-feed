import {createConsumer} from '@mereb/shared-packages';
import type {Consumer, KafkaConfig} from 'kafkajs';
import {prisma} from './prisma.js';
import {createChildLogger} from './logger.js';
import type {PostCreatedEvent} from './kafka.js';

const logger = createChildLogger({module: 'home-feed-worker'});
const INSERT_BATCH_SIZE = 500;

function getPostCreatedTopic() {
    return process.env.KAFKA_TOPIC_POST_CREATED ?? 'post.created.v1';
}

function getConsumerGroupId() {
    return process.env.KAFKA_HOME_FEED_GROUP_ID ?? 'svc-feed-home-feed';
}

async function fetchFollowerIds(authorId: string): Promise<string[]> {
    try {
        const rows = await prisma.$queryRaw<Array<{followerId: string}>>`
            SELECT "followerId" FROM "Follow" WHERE "followingId" = ${authorId}
        `;
        return rows.map((row) => row.followerId);
    } catch (err) {
        logger.error({err, authorId}, 'Failed to load followers for author');
        return [];
    }
}

async function fanOutPostToHomeFeed(event: PostCreatedEvent) {
    const postId = event.data?.post_id;
    const authorId = event.data?.author_id;
    if (!postId || !authorId) {
        logger.warn({event}, 'Received post.created event without ids');
        return;
    }

    const followers = await fetchFollowerIds(authorId);
    const recipients = new Set<string>(['anon', authorId, ...followers]);
    if (recipients.size === 0) {
        return;
    }

    const insertedAt = event.data?.created_at
        ? new Date(event.data.created_at)
        : new Date();
    const payloads = Array.from(recipients).map((ownerId) => ({
        ownerId,
        postId,
        insertedAt
    }));

    for (let i = 0; i < payloads.length; i += INSERT_BATCH_SIZE) {
        const batch = payloads.slice(i, i + INSERT_BATCH_SIZE);
        try {
            await prisma.homeFeed.createMany({
                data: batch,
                skipDuplicates: true
            });
        } catch (err) {
            logger.error(
                {err, batchSize: batch.length},
                'Failed to insert home feed rows'
            );
        }
    }
}

export async function startHomeFeedWorker(
    kafkaConfig: KafkaConfig | null
): Promise<Consumer | null> {
    if (!kafkaConfig) {
        logger.warn('Kafka config missing; home feed worker disabled');
        return null;
    }

    const consumer = await createConsumer(kafkaConfig, getConsumerGroupId());
    const topic = getPostCreatedTopic();
    await consumer.subscribe({topic, fromBeginning: false});

    consumer.run({
        eachMessage: async ({message, partition, topic}) => {
            const value = message.value?.toString();
            if (!value) {
                logger.warn(
                    {topic, partition, offset: message.offset},
                    'Skipping message with no value'
                );
                return;
            }

            let parsed: PostCreatedEvent | null = null;
            try {
                parsed = JSON.parse(value) as PostCreatedEvent;
            } catch (err) {
                logger.error(
                    {err, value},
                    'Failed to parse post.created message value'
                );
                return;
            }

            try {
                await fanOutPostToHomeFeed(parsed);
            } catch (err) {
                logger.error(
                    {err, topic, partition, offset: message.offset},
                    'Failed to fan out post.created event'
                );
            }
        }
    }).catch((err) => {
        logger.error({err}, 'Home feed consumer crashed');
    });

    logger.info(
        {topic, groupId: getConsumerGroupId()},
        'Home feed worker started'
    );

    return consumer;
}
