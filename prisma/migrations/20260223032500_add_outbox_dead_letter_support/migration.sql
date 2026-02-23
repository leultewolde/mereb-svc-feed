-- Create enum for explicit outbox statuses
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER');

-- Convert existing status column to enum
ALTER TABLE "OutboxEvent"
ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "OutboxEvent"
ALTER COLUMN "status" TYPE "OutboxEventStatus"
USING ("status"::"OutboxEventStatus");

ALTER TABLE "OutboxEvent"
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Add dead-letter metadata columns
ALTER TABLE "OutboxEvent"
ADD COLUMN "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN "deadLetterTopic" TEXT;
