import { metrics } from '@opentelemetry/api';
import type { FeedOutboxStatusCounts } from '../adapters/outbound/prisma/feed-prisma-repository.js';

export interface OutboxFlushMetricsInput {
  batchSize: number;
  publishedCount: number;
  retryScheduledCount: number;
  terminalFailureCount: number;
  skippedCount: number;
}

const meter = metrics.getMeter('svc-feed-outbox-relay');
const attrs = {
  service: 'svc-feed',
  outbox: 'feed'
} as const;

let depthSnapshot: FeedOutboxStatusCounts = {
  pending: 0,
  processing: 0,
  published: 0,
  failed: 0,
  deadLetter: 0
};

const queueDepthGauge = meter.createObservableGauge('mereb_outbox_queue_depth', {
  description: 'Current outbox queue depth by status'
});

queueDepthGauge.addCallback((observableResult) => {
  observableResult.observe(depthSnapshot.pending, { ...attrs, status: 'PENDING' });
  observableResult.observe(depthSnapshot.processing, { ...attrs, status: 'PROCESSING' });
  observableResult.observe(depthSnapshot.published, { ...attrs, status: 'PUBLISHED' });
  observableResult.observe(depthSnapshot.failed, { ...attrs, status: 'FAILED' });
  observableResult.observe(depthSnapshot.deadLetter, { ...attrs, status: 'DEAD_LETTER' });
});

const publishedCounter = meter.createCounter('mereb_outbox_published_total', {
  description: 'Total outbox events successfully published'
});
const retryScheduledCounter = meter.createCounter('mereb_outbox_retry_scheduled_total', {
  description: 'Total outbox retries scheduled after publish failure'
});
const deadLetterCounter = meter.createCounter('mereb_outbox_dead_letter_total', {
  description: 'Total outbox events moved to dead-letter terminal status'
});
const skippedCounter = meter.createCounter('mereb_outbox_skipped_claim_total', {
  description: 'Total outbox relay events skipped because claim failed'
});
const flushCounter = meter.createCounter('mereb_outbox_flush_total', {
  description: 'Total outbox relay flush executions with non-empty batches'
});
const batchSizeHistogram = meter.createHistogram('mereb_outbox_flush_batch_size', {
  description: 'Outbox relay flush batch size'
});

export function setFeedOutboxQueueDepth(counts: FeedOutboxStatusCounts): void {
  depthSnapshot = counts;
}

export function recordFeedOutboxFlushMetrics(input: OutboxFlushMetricsInput): void {
  flushCounter.add(1, attrs);
  batchSizeHistogram.record(input.batchSize, attrs);

  if (input.publishedCount > 0) {
    publishedCounter.add(input.publishedCount, attrs);
  }
  if (input.retryScheduledCount > 0) {
    retryScheduledCounter.add(input.retryScheduledCount, attrs);
  }
  if (input.terminalFailureCount > 0) {
    deadLetterCounter.add(input.terminalFailureCount, attrs);
  }
  if (input.skippedCount > 0) {
    skippedCounter.add(input.skippedCount, attrs);
  }
}

