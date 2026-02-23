-- Create inbox table for idempotent Kafka consumer processing
CREATE TABLE "InboxEvent" (
    "id" TEXT NOT NULL,
    "consumerGroup" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER,
    "offset" TEXT,
    "eventId" TEXT,
    "eventKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboxEvent_consumerGroup_eventKey_key"
ON "InboxEvent"("consumerGroup", "eventKey");

CREATE INDEX "InboxEvent_consumerGroup_status_idx"
ON "InboxEvent"("consumerGroup", "status");
