import { registerAs } from '@nestjs/config';

export interface SqsConfig {
  endpoint?: string;
  region: string;
  billingCommandQueueUrl?: string;
  executionCommandQueueUrl?: string;
  resultsQueueUrl?: string;
  outboxRelayEnabled: boolean;
  resultsConsumerEnabled: boolean;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  outboxLeaseMs: number;
}

export const sqsConfig = registerAs('sqs', (): SqsConfig => ({
  endpoint: process.env.SQS_ENDPOINT_URL || undefined,
  region: process.env.SQS_REGION ?? 'us-east-1',
  billingCommandQueueUrl:
    process.env.SQS_BILLING_COMMAND_QUEUE_URL || undefined,
  executionCommandQueueUrl:
    process.env.SQS_EXECUTION_COMMAND_QUEUE_URL || undefined,
  resultsQueueUrl: process.env.SQS_RESULTS_QUEUE_URL || undefined,
  outboxRelayEnabled: process.env.SQS_OUTBOX_RELAY_ENABLED === 'true',
  resultsConsumerEnabled: process.env.SQS_RESULTS_CONSUMER_ENABLED === 'true',
  outboxPollIntervalMs: Number.parseInt(
    process.env.SQS_OUTBOX_POLL_INTERVAL_MS ?? '1000',
    10,
  ),
  outboxBatchSize: Number.parseInt(
    process.env.SQS_OUTBOX_BATCH_SIZE ?? '10',
    10,
  ),
  outboxLeaseMs: Number.parseInt(
    process.env.SQS_OUTBOX_LEASE_MS ?? '30000',
    10,
  ),
}));
