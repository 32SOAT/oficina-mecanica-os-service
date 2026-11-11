import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SagaStepStatus } from '../contracts/saga-message';

@Entity('saga_execution')
@Index('IDX_saga_execution_os_id', ['osId'])
export class SagaExecutionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'os_id', type: 'uuid' })
  osId: string;

  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Column({ name: 'requested_by', type: 'uuid', nullable: true })
  requestedBy: string | null;

  @Column({ type: 'varchar', length: 32, default: SagaStepStatus.Pendente })
  status: SagaStepStatus;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  context: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp', precision: 3 })
  updatedAt: Date;
}
