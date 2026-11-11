import { SagaResultProcessor } from './saga-result.processor';
import { SagaResultMessage } from './contracts/saga-message';
import { StatusOrdemServico } from '../ordens-de-servico/domain/status-ordem-servico.enum';

describe('SagaResultProcessor', () => {
  const result: SagaResultMessage = {
    messageId: '7d9f9748-b2d2-46ab-8106-fd5dad738b19',
    commandId: 'a707820e-fbe3-483a-b5ae-3a69a3eb947c',
    sagaId: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
    osId: '9abeb153-d57f-4a92-b32a-918fc9e4abc0',
    occurredAt: '2026-11-07T12:00:00.000Z',
    correlationId: 'request-1',
    causationId: 'd1bfe9c4-d8cb-4c93-b9bc-18156d3d9141',
    schemaVersion: 1,
    type: 'SAGA_STEP_RESULT',
    outcome: 'CONCLUIDA',
    payload: {},
  };

  it('emits status side effects only after a newly committed result', async () => {
    const events = {
      emitStatusNotificacao: jest.fn(),
      emitOrcamentoGerado: jest.fn(),
      emitOrcamentoAprovado: jest.fn(),
      emitOrcamentoReprovado: jest.fn(),
      emitOsEmExecucao: jest.fn(),
    };
    const transaction = {
      processSagaResult: jest.fn().mockResolvedValue({
        duplicate: false,
        statusChanges: [
          {
            osId: result.osId,
            statusAnterior: StatusOrdemServico.Recebida,
            statusNovo: StatusOrdemServico.EmDiagnostico,
            usuarioId: 'actor-id',
          },
        ],
        domainEvents: ['ORCAMENTO_GERADO'],
      }),
    };
    const processor = new SagaResultProcessor(
      transaction as never,
      events as never,
    );

    await expect(processor.process(result)).resolves.toEqual({
      duplicate: false,
    });
    expect(transaction.processSagaResult).toHaveBeenCalledWith(result);
    expect(events.emitStatusNotificacao).toHaveBeenCalledWith(
      result.osId,
      StatusOrdemServico.Recebida,
      StatusOrdemServico.EmDiagnostico,
      'actor-id',
    );
    expect(events.emitOrcamentoGerado).toHaveBeenCalledWith(result.osId);
  });

  it('does not emit side effects for a duplicate result', async () => {
    const events = {
      emitStatusNotificacao: jest.fn(),
      emitOrcamentoGerado: jest.fn(),
      emitOrcamentoAprovado: jest.fn(),
      emitOrcamentoReprovado: jest.fn(),
      emitOsEmExecucao: jest.fn(),
    };
    const processor = new SagaResultProcessor(
      {
        processSagaResult: jest.fn().mockResolvedValue({
          duplicate: true,
          statusChanges: [],
          domainEvents: [],
        }),
      } as never,
      events as never,
    );

    await expect(processor.process(result)).resolves.toEqual({
      duplicate: true,
    });
    expect(events.emitStatusNotificacao).not.toHaveBeenCalled();
  });
});
