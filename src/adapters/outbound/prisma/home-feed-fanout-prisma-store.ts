import { Prisma } from '../../../../generated/client/index.js';
import { prisma } from '../../../prisma.js';
import { createChildLogger } from '../../../logger.js';
import type {
  HomeFeedFanoutRow,
  HomeFeedFanoutStorePort,
  HomeFeedInboxStorePort
} from '../../../application/feed/home-feed-fanout.js';

const logger = createChildLogger({ module: 'home-feed-fanout-prisma-store' });

export class HomeFeedFanoutPrismaStoreAdapter
  implements HomeFeedFanoutStorePort, HomeFeedInboxStorePort
{
  async listFollowerIds(authorId: string): Promise<string[]> {
    try {
      const rows = await prisma.$queryRaw<Array<{ followerId: string }>>`
        SELECT "followerId" FROM "Follow" WHERE "followingId" = ${authorId}
      `;
      return rows.map((row) => row.followerId);
    } catch (error) {
      logger.error({ err: error, authorId }, 'Failed to load followers for author');
      return [];
    }
  }

  async insertHomeFeedRows(rows: HomeFeedFanoutRow[], batchSize = 500): Promise<void> {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        await prisma.homeFeed.createMany({
          data: batch,
          skipDuplicates: true
        });
      } catch (error) {
        logger.error(
          { err: error, batchSize: batch.length },
          'Failed to insert home feed rows'
        );
      }
    }
  }

  async claimInboxEvent(input: {
    consumerGroup: string;
    topic: string;
    partition: number;
    offset: string;
    eventId?: string;
    eventKey: string;
  }): Promise<boolean> {
    try {
      await prisma.inboxEvent.create({
        data: {
          consumerGroup: input.consumerGroup,
          topic: input.topic,
          partition: input.partition,
          offset: input.offset,
          eventId: input.eventId,
          eventKey: input.eventKey,
          status: 'PROCESSING'
        }
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  async markInboxEventProcessed(input: {
    consumerGroup: string;
    eventKey: string;
  }): Promise<void> {
    await prisma.inboxEvent.update({
      where: {
        consumerGroup_eventKey: {
          consumerGroup: input.consumerGroup,
          eventKey: input.eventKey
        }
      },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        lastError: null
      }
    });
  }

  async markInboxEventFailed(input: {
    consumerGroup: string;
    eventKey: string;
    errorMessage: string;
  }): Promise<void> {
    await prisma.inboxEvent
      .update({
        where: {
          consumerGroup_eventKey: {
            consumerGroup: input.consumerGroup,
            eventKey: input.eventKey
          }
        },
        data: {
          status: 'FAILED',
          lastError: input.errorMessage
        }
      })
      .catch((error) => {
        logger.error(
          { err: error, consumerGroup: input.consumerGroup, eventKey: input.eventKey },
          'Failed to mark inbox event as failed'
        );
      });
  }
}
