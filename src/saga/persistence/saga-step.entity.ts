import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SagaCommandType, SagaStepStatus } from '../contracts/saga-message';

@Entity('saga_step')
@Index('UQ_saga_step_saga_sequence', ['sagaId', 'sequence'], { unique: true })
@Index('IDX_saga_step_saga_id', ['sagaId'])
export class SagaStepEntity {
  @PrimaryColumn('uuid', { name: 'command_id' })
  commandId: string;

  @Column({ name: 'saga_id', type: 'uuid' })
  sagaId: string;

  @Column({ type: 'integer' })
  sequence: number;

  @Column({ name: 'command_type', type: 'varchar', length: 64 })
  commandType: SagaCommandType;

  @Column({ type: 'varchar', length: 16 })
  destination: 'BILLING' | 'EXECUCAO';

  @Column({ type: 'varchar', length: 32, default: SagaStepStatus.Pendente })
  status: SagaStepStatus;

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ type: 'boolean', default: false })
  retryable: boolean;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  lastErrorCode: string | null;

  @Column({ name: 'last_error_message', type: 'text', nullable: true })
  lastErrorMessage: string | null;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp', precision: 3 })
  updatedAt: Date;

  @Column({
    name: 'completed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
  })
  completedAt: Date | null;
}
