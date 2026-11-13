import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '../../config/config.module';
import { SagaCommandMessage } from '../contracts/saga-message';
import { SagaCommandDestination } from '../../ordens-de-servico/application/ports/ordem-servico-transaction.port';
import { SqsCommandPublisher } from './sqs-command-publisher';

type ClaimedOutboxMessage = {
  message_id: string;
  command_id: string;
  destination: SagaCommandDestination;
  body: SagaCommandMessage | string;
  attempt_count: number;
};

const CLAIM_PENDING_SQL = `
  WITH candidates AS (
    SELECT message_id
    FROM saga_outbox
    WHERE published_at IS NULL
      AND available_at <= NOW()
      AND (locked_until IS NULL OR locked_until <= NOW())
    ORDER BY available_at, created_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE saga_outbox AS outbox
  SET locked_until = NOW() + ($2 * INTERVAL '1 millisecond'),
      attempt_count = outbox.attempt_count + 1
  FROM candidates
  WHERE outbox.message_id = candidates.message_id
  RETURNING outbox.message_id, outbox.command_id, outbox.destination,
            outbox.body, outbox.attempt_count
`;

const MARK_PUBLISHED_SQL = `
  UPDATE saga_outbox
  SET published_at = NOW(), locked_until = NULL
  WHERE message_id = $1 AND published_at IS NULL
`;

const RELEASE_FOR_RETRY_SQL = `
  UPDATE saga_outbox
  SET locked_until = NULL,
      available_at = NOW() + ($2 * INTERVAL '1 millisecond')
  WHERE message_id = $1 AND published_at IS NULL
`;

@Injectable()
export class SagaOutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaOutboxRelay.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private publishing = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisher: SqsCommandPublisher,
    private readonly config: ConfigService<ConfigType>,
  ) {}

  onModuleInit(): void {
    const sqs = this.config.getOrThrow('sqs', { infer: true });
    if (!sqs.outboxRelayEnabled) return;

    void this.pollSafely();
    this.timer = setInterval(
      () => void this.pollSafely(),
      sqs.outboxPollIntervalMs,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async publishPendingBatch(): Promise<number> {
    if (this.publishing) return 0;
    this.publishing = true;
    try {
      const sqs = this.config.getOrThrow('sqs', { infer: true });
      const claimed = (await this.dataSource.transaction((manager) =>
        manager.query(CLAIM_PENDING_SQL, [
          sqs.outboxBatchSize,
          sqs.outboxLeaseMs,
        ]),
      )) as unknown;
      const messages =
        Array.isArray(claimed) && Array.isArray(claimed[0])
          ? (claimed[0] as ClaimedOutboxMessage[])
          : (claimed as ClaimedOutboxMessage[]);

      let published = 0;
      for (const row of messages) {
        try {
          const body =
            typeof row.body === 'string'
              ? (JSON.parse(row.body) as SagaCommandMessage)
              : row.body;
          await this.publisher.publish(body, row.destination);
          await this.dataSource.query(MARK_PUBLISHED_SQL, [row.message_id]);
          published += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'erro';
          this.logger.warn(
            `Falha ao publicar o comando ${row.command_id} no SQS: ${message}`,
          );
          const delayMs = Math.min(
            60_000,
            1_000 * 2 ** Math.min(row.attempt_count - 1, 6),
          );
          await this.dataSource.query(RELEASE_FOR_RETRY_SQL, [
            row.message_id,
            delayMs,
          ]);
        }
      }
      return published;
    } finally {
      this.publishing = false;
    }
  }

  private async pollSafely(): Promise<void> {
    try {
      await this.publishPendingBatch();
    } catch (error) {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : 'erro';
      this.logger.error(`Falha no relay da outbox da Saga: ${message}`);
    }
  }
}
