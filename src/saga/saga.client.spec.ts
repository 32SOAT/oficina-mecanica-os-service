import { BadRequestException } from '@nestjs/common';
import { SagaClient } from './saga.client';
import { SagaCommandType } from './contracts/saga-message';
import {
  CreateSagaCommandInput,
  OrdemServicoTransactionalOperations,
} from '../ordens-de-servico/application/ports/ordem-servico-transaction.port';

describe('SagaClient', () => {
  let tx: {
    lockOsAndEnsureNoActiveSaga: jest.Mock;
    loadOs: jest.Mock;
    createSagaCommand: jest.Mock<Promise<void>, [CreateSagaCommandInput]>;
    refreshValorTotal: jest.Mock;
  };
  let transaction: { runInTransaction: jest.Mock };
  let client: SagaClient;
  let os: {
    id: string;
    status: string;
    valorTotal: number;
    avancarStatus: jest.Mock;
    calcularValorTotal: jest.Mock;
  };

  beforeEach(() => {
    process.env.BILLING_BASE_URL = 'http://billing.test';
    process.env.SAGA_TOKEN = 'oficina-local';
    os = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'RECEBIDA',
      valorTotal: 125,
      avancarStatus: jest.fn((next: string) => ({
        anterior: os.status,
        novo: next,
      })),
      calcularValorTotal: jest.fn(() => 125),
    };
    tx = {
      lockOsAndEnsureNoActiveSaga: jest.fn().mockResolvedValue(undefined),
      loadOs: jest.fn().mockResolvedValue(os),
      createSagaCommand: jest.fn().mockResolvedValue(undefined),
      refreshValorTotal: jest.fn(),
    };
    transaction = {
      runInTransaction: jest.fn(
        (
          work: (
            operations: OrdemServicoTransactionalOperations,
          ) => Promise<unknown>,
        ) => work(tx as unknown as OrdemServicoTransactionalOperations),
      ),
    };
    client = new SagaClient(transaction as never);
  });

  it('creates the first diagnosis command transactionally and returns its pending identifiers', async () => {
    const accepted = await client.abrirDiagnostico(os.id, 'actor-id');

    expect(accepted).toMatchObject({ osId: os.id, status: 'PENDENTE' });
    expect(accepted.sagaId).toEqual(expect.any(String));
    expect(accepted.commandId).toEqual(expect.any(String));
    const input = tx.createSagaCommand.mock.calls[0][0];
    expect(input.execution).toMatchObject({
      id: accepted.sagaId,
      osId: os.id,
      action: 'INICIAR_DIAGNOSTICO',
      requestedBy: 'actor-id',
    });
    expect(input.step).toMatchObject({
      sequence: 1,
      destination: 'EXECUCAO',
      command: {
        commandId: accepted.commandId,
        sagaId: accepted.sagaId,
        osId: os.id,
        type: SagaCommandType.ExecutionOpen,
        payload: { etapa: 'DIAGNOSTICO' },
      },
    });
    expect(os.avancarStatus).toHaveBeenCalledWith('EM_DIAGNOSTICO');
    expect(tx.lockOsAndEnsureNoActiveSaga).toHaveBeenCalledWith(os.id);
    expect(
      tx.lockOsAndEnsureNoActiveSaga.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.loadOs.mock.invocationCallOrder[0]);
  });

  it('freezes the quote total in Saga context and does not advance the canonical status', async () => {
    os.status = 'EM_DIAGNOSTICO';

    const accepted = await client.gerarOrcamento(os.id, 'actor-id');

    expect(accepted.status).toBe('PENDENTE');
    expect(tx.refreshValorTotal).toHaveBeenCalledWith(os);
    expect(tx.lockOsAndEnsureNoActiveSaga).toHaveBeenCalledWith(os.id);
    expect(
      tx.lockOsAndEnsureNoActiveSaga.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.loadOs.mock.invocationCallOrder[0]);
    expect(tx.createSagaCommand.mock.calls[0][0].execution.context).toEqual({
      valorTotal: 125,
    });
    expect(tx.createSagaCommand.mock.calls[0][0].step.command.type).toBe(
      SagaCommandType.ExecutionComplete,
    );
    expect(os.avancarStatus).toHaveBeenCalledWith('AGUARDANDO_APROVACAO');
    expect(os.status).toBe('EM_DIAGNOSTICO');
  });

  it('rejects an invalid action before writing a Saga', async () => {
    os.avancarStatus.mockImplementation(() => {
      throw new BadRequestException('invalid transition');
    });

    await expect(client.abrirDiagnostico(os.id, 'actor-id')).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.createSagaCommand).not.toHaveBeenCalled();
  });

  it('blocks delivery until the payment is approved', async () => {
    process.env.BILLING_BASE_URL = 'http://billing.test';
    process.env.SAGA_TOKEN = 'oficina-local';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":{"status":"PENDENTE"}}'),
    } as Response);

    await expect(client.exigirPagamentoAprovado(os.id)).rejects.toThrow(
      BadRequestException,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `http://billing.test/api/v1/pagamentos/${os.id}`,
      {
        method: 'GET',
        headers: { 'x-saga-token': 'oficina-local' },
      },
    );
  });
});
