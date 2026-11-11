import { SagaStatusResponseDto } from './saga-status-response.dto';

describe('SagaStatusResponseDto', () => {
  it('returns ordered step status without envelopes or private context', () => {
    const createdAt = new Date('2026-11-08T10:00:00.000Z');
    const response = SagaStatusResponseDto.fromReadModel({
      sagaId: 'saga-id',
      osId: 'os-id',
      action: 'GERAR_ORCAMENTO',
      status: 'PENDENTE',
      createdAt,
      updatedAt: createdAt,
      steps: [
        {
          commandId: 'command-id',
          sequence: 1,
          commandType: 'EXECUTION_COMPLETE',
          status: 'CONCLUIDA',
          attemptCount: 1,
          retryable: false,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: createdAt,
        },
      ],
    });

    expect(response).toEqual({
      sagaId: 'saga-id',
      osId: 'os-id',
      action: 'GERAR_ORCAMENTO',
      status: 'PENDENTE',
      createdAt,
      updatedAt: createdAt,
      steps: [
        {
          commandId: 'command-id',
          sequence: 1,
          commandType: 'EXECUTION_COMPLETE',
          status: 'CONCLUIDA',
          attemptCount: 1,
          retryable: false,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: createdAt,
        },
      ],
    });
    expect(response).not.toHaveProperty('context');
    expect(response.steps[0]).not.toHaveProperty('result');
  });
});
