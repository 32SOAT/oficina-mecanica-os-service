import { ApiProperty } from '@nestjs/swagger';
import {
  SagaStatusQuery,
  SagaStepQuery,
} from '../../ordens-de-servico/application/ports/ordem-servico-transaction.port';
import { SagaStepStatus } from '../contracts/saga-message';

export class SagaAcceptedResponseDto {
  @ApiProperty({ format: 'uuid' })
  osId: string;

  @ApiProperty({ format: 'uuid' })
  sagaId: string;

  @ApiProperty({ format: 'uuid' })
  commandId: string;

  @ApiProperty({ enum: ['PENDENTE'] })
  status: 'PENDENTE';
}

export class SagaStepStatusResponseDto {
  @ApiProperty({ format: 'uuid' })
  commandId: string;

  @ApiProperty({ minimum: 1 })
  sequence: number;

  @ApiProperty()
  commandType: string;

  @ApiProperty({ enum: SagaStepStatus })
  status: SagaStepStatus;

  @ApiProperty()
  attemptCount: number;

  @ApiProperty()
  retryable: boolean;

  @ApiProperty({ nullable: true })
  lastErrorCode: string | null;

  @ApiProperty({ nullable: true })
  lastErrorMessage: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ nullable: true })
  completedAt: Date | null;

  static fromReadModel(model: SagaStepQuery): SagaStepStatusResponseDto {
    return Object.assign(new SagaStepStatusResponseDto(), model);
  }
}

export class SagaStatusResponseDto {
  @ApiProperty({ format: 'uuid' })
  sagaId: string;

  @ApiProperty({ format: 'uuid' })
  osId: string;

  @ApiProperty()
  action: string;

  @ApiProperty({ enum: SagaStepStatus })
  status: SagaStepStatus;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ type: () => SagaStepStatusResponseDto, isArray: true })
  steps: SagaStepStatusResponseDto[];

  static fromReadModel(model: SagaStatusQuery): SagaStatusResponseDto {
    return Object.assign(new SagaStatusResponseDto(), {
      ...model,
      steps: model.steps.map((step) =>
        SagaStepStatusResponseDto.fromReadModel(step),
      ),
    });
  }
}
