import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { SagaCommandMessage } from '../contracts/saga-message';

@Entity('saga_outbox')
@Index('IDX_saga_outbox_pending', ['availableAt', 'destination'], {
  where: 'published_at IS NULL',
})
export class SagaOutboxEntity {
  @PrimaryColumn('uuid', { name: 'message_id' })
  messageId: string;

  @Column({ name: 'command_id', type: 'uuid', unique: true })
  commandId: string;

  @Column({ type: 'varchar', length: 16 })
  destination: 'BILLING' | 'EXECUCAO';

  @Column({ type: 'jsonb' })
  body: SagaCommandMessage;

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount: number;

  @Column({
    name: 'available_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
  })
  availableAt: Date;

  @Column({
    name: 'locked_until',
    type: 'timestamp',
    precision: 3,
    nullable: true,
  })
  lockedUntil: Date | null;

  @Column({
    name: 'published_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
  })
  publishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp', precision: 3 })
  createdAt: Date;
}
