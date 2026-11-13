import { DataSource, EntityManager } from 'typeorm';
import {
  SagaResultMessage,
  SagaCommandMessage,
  SagaCommandType,
} from './contracts/saga-message';
import { OrdemServicoTypeormTransaction } from '../ordens-de-servico/infrastructure/persistence/ordem-servico.typeorm-transaction';
import { OrdemServicoTypeormEntity } from '../ordens-de-servico/infrastructure/typeorm/entity/ordem-servico.typeorm.entity';
import { HistoricoStatusOsEntity } from '../ordens-de-servico/infrastructure/typeorm/entity/historico-status-os.entity';
import { SagaExecutionEntity } from './persistence/saga-execution.entity';
import { SagaOutboxEntity } from './persistence/saga-outbox.entity';
import { SagaStepEntity } from './persistence/saga-step.entity';
import { StatusOrdemServico } from '../ordens-de-servico/domain/status-ordem-servico.enum';

describe('Saga result transaction', () => {
  const ids = {
    osId: '9abeb153-d57f-4a92-b32a-918fc9e4abc0',
    sagaId: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
    commandId: 'a707820e-fbe3-483a-b5ae-3a69a3eb947c',
    messageId: '7d9f9748-b2d2-46ab-8106-fd5dad738b19',
  };

  let os: OrdemServicoTypeormEntity;
  let execution: SagaExecutionEntity;
  let step: SagaStepEntity;
  let command: SagaCommandMessage;
  let manager: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    softRemove: jest.Mock;
  };
  let estoque: {
    estornarReservas: jest.Mock;
    estoqueCobreReservaAtual: jest.Mock;
    darBaixaEmExecucao: jest.Mock;
  };
  let transaction: OrdemServicoTypeormTransaction;

  beforeEach(() => {
    os = Object.assign(new OrdemServicoTypeormEntity(), {
      id: ids.osId,
      status: StatusOrdemServico.Recebida,
      valorTotal: 125,
      observacao: null,
      itensServico: [],
      itensPeca: [],
    });
    execution = Object.assign(new SagaExecutionEntity(), {
      id: ids.sagaId,
      osId: ids.osId,
      action: 'INICIAR_DIAGNOSTICO',
      requestedBy: 'actor-id',
      context: {},
      status: 'PENDENTE',
    });
    command = {
      messageId: ids.messageId,
      commandId: ids.commandId,
      sagaId: ids.sagaId,
      osId: ids.osId,
      occurredAt: '2026-11-07T12:00:00.000Z',
      correlationId: ids.sagaId,
      causationId: null,
      schemaVersion: 1,
      type: SagaCommandType.ExecutionOpen,
      payload: { etapa: 'DIAGNOSTICO' },
    };
    step = Object.assign(new SagaStepEntity(), {
      commandId: ids.commandId,
      sagaId: ids.sagaId,
      sequence: 1,
      commandType: command.type,
      destination: 'EXECUCAO',
      status: 'PENDENTE',
      attemptCount: 0,
      retryable: false,
      result: null,
    });
    manager = {
      create: jest.fn(
        (_entity: unknown, data: Record<string, unknown>) => data,
      ),
      save: jest.fn((_entity: unknown, data: unknown) => Promise.resolve(data)),
      findOne: jest.fn((entity: unknown) => {
        if (entity === SagaStepEntity) return Promise.resolve(step);
        if (entity === SagaExecutionEntity) return Promise.resolve(execution);
        if (entity === SagaOutboxEntity)
          return Promise.resolve({
            commandId: ids.commandId,
            destination: command.type.startsWith('BILLING_')
              ? 'BILLING'
              : 'EXECUCAO',
            body: command,
          });
        if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
        return Promise.resolve(null);
      }),
      find: jest.fn().mockResolvedValue([]),
      softRemove: jest.fn().mockResolvedValue(undefined),
    };
    estoque = {
      estornarReservas: jest.fn().mockResolvedValue(undefined),
      estoqueCobreReservaAtual: jest.fn().mockResolvedValue(true),
      darBaixaEmExecucao: jest.fn().mockResolvedValue(undefined),
    };
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: manager as unknown as EntityManager,
    };
    transaction = new OrdemServicoTypeormTransaction(
      {
        createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      } as unknown as DataSource,
      { findIdByDocumento: jest.fn() },
      { findIdForCliente: jest.fn() },
      { findPreco: jest.fn() },
      {
        reservarParaOrdemServico: jest.fn(),
        ...estoque,
      },
    );
  });

  const makeResult = (
    overrides: Partial<SagaResultMessage> = {},
  ): SagaResultMessage =>
    ({
      ...command,
      type: 'SAGA_STEP_RESULT',
      messageId: 'b34ac29e-dd88-4a8e-a5ab-79ed76f1fbc8',
      causationId: command.messageId,
      outcome: 'CONCLUIDA',
      payload: {},
      ...overrides,
    }) as SagaResultMessage;

  it('applies the canonical status, history and step result in one transaction', async () => {
    const result = makeResult();

    const processed = await transaction.processSagaResult(result);

    expect(processed).toMatchObject({
      duplicate: false,
      statusChanges: [
        {
          osId: ids.osId,
          statusAnterior: StatusOrdemServico.Recebida,
          statusNovo: StatusOrdemServico.EmDiagnostico,
          usuarioId: 'actor-id',
        },
      ],
    });
    expect(os.status).toBe(StatusOrdemServico.EmDiagnostico);
    expect(step.status).toBe('CONCLUIDA');
    expect(execution.status).toBe('CONCLUIDA');
    expect(manager.save).toHaveBeenCalledWith(
      HistoricoStatusOsEntity,
      expect.objectContaining({
        os_id: ids.osId,
        statusAnterior: StatusOrdemServico.Recebida,
        statusNovo: StatusOrdemServico.EmDiagnostico,
      }),
    );
  });

  it('records a participant failure without changing the OS status', async () => {
    const result = makeResult({
      outcome: 'FALHA',
      payload: { code: 'BUSINESS_RULE', message: 'rejected', retryable: false },
    });

    await transaction.processSagaResult(result);

    expect(os.status).toBe(StatusOrdemServico.Recebida);
    expect(step.status).toBe('FALHA');
    expect(step.retryable).toBe(false);
    expect(step.attemptCount).toBe(1);
    expect(execution.status).toBe('FALHA');
  });

  it('queues diagnosis compensation when Billing quote generation fails after execution completion', async () => {
    os.status = StatusOrdemServico.EmDiagnostico;
    execution.action = 'GERAR_ORCAMENTO';
    command.type = SagaCommandType.BillingQuoteGenerate;
    command.payload = { valorTotal: 125 };
    step.commandType = command.type;
    step.destination = 'BILLING';
    step.sequence = 2;
    manager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: Record<string, unknown> } | undefined)
        ?.where;
      if (entity === SagaStepEntity && where?.sequence)
        return Promise.resolve(null);
      if (entity === SagaStepEntity) return Promise.resolve(step);
      if (entity === SagaExecutionEntity) return Promise.resolve(execution);
      if (entity === SagaOutboxEntity)
        return Promise.resolve({
          commandId: ids.commandId,
          destination: 'BILLING',
          body: command,
        });
      if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
      return Promise.resolve(null);
    });

    await transaction.processSagaResult(
      makeResult({
        outcome: 'FALHA',
        payload: { code: 'QUOTE_ERROR', message: 'failed', retryable: false },
      }),
    );

    expect(os.status).toBe(StatusOrdemServico.EmDiagnostico);
    expect(step.status).toBe('FALHA');
    expect(execution.status).toBe('COMPENSANDO');
    expect(manager.save).toHaveBeenCalledWith(
      SagaStepEntity,
      expect.objectContaining({
        sequence: 3,
        commandType: SagaCommandType.ExecutionReopen,
      }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      SagaOutboxEntity,
      expect.objectContaining({
        body: expect.objectContaining({
          type: SagaCommandType.ExecutionReopen,
          payload: { etapa: 'DIAGNOSTICO' },
        }),
      }),
    );
  });

  it('queues repair compensation when Billing payment opening fails', async () => {
    os.status = StatusOrdemServico.Finalizada;
    execution.action = 'FINALIZAR';
    command.type = SagaCommandType.BillingPaymentOpen;
    command.payload = { valorTotal: 125 };
    step.commandType = command.type;
    step.destination = 'BILLING';
    step.sequence = 2;
    manager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: Record<string, unknown> } | undefined)
        ?.where;
      if (entity === SagaStepEntity && where?.sequence)
        return Promise.resolve(null);
      if (entity === SagaStepEntity) return Promise.resolve(step);
      if (entity === SagaExecutionEntity) return Promise.resolve(execution);
      if (entity === SagaOutboxEntity)
        return Promise.resolve({
          commandId: ids.commandId,
          destination: 'BILLING',
          body: command,
        });
      if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
      return Promise.resolve(null);
    });

    await transaction.processSagaResult(
      makeResult({
        outcome: 'FALHA',
        payload: { code: 'PAYMENT_ERROR', message: 'failed', retryable: false },
      }),
    );

    expect(execution.status).toBe('COMPENSANDO');
    expect(os.status).toBe(StatusOrdemServico.Finalizada);
    expect(manager.save).toHaveBeenCalledWith(
      SagaOutboxEntity,
      expect.objectContaining({
        body: expect.objectContaining({
          type: SagaCommandType.ExecutionReopen,
          payload: { etapa: 'REPARO' },
        }),
      }),
    );
  });

  it('accepts compensation result only when the immediately previous step failed', async () => {
    execution.action = 'GERAR_ORCAMENTO';
    execution.status = 'COMPENSANDO';
    command.type = SagaCommandType.ExecutionReopen;
    command.payload = { etapa: 'DIAGNOSTICO' };
    step.commandType = command.type;
    step.sequence = 3;
    manager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: Record<string, unknown> } | undefined)
        ?.where;
      if (entity === SagaStepEntity && where?.sequence)
        return Promise.resolve({ sequence: 2, status: 'FALHA' });
      if (entity === SagaStepEntity) return Promise.resolve(step);
      if (entity === SagaExecutionEntity) return Promise.resolve(execution);
      if (entity === SagaOutboxEntity)
        return Promise.resolve({
          commandId: ids.commandId,
          destination: 'EXECUCAO',
          body: command,
        });
      if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
      return Promise.resolve(null);
    });

    await transaction.processSagaResult(makeResult());
    expect(execution.status).toBe('COMPENSADA');
  });

  it('restores EM_EXECUCAO after repair compensation succeeds', async () => {
    os.status = StatusOrdemServico.Finalizada;
    execution.action = 'FINALIZAR';
    execution.status = 'COMPENSANDO';
    command.type = SagaCommandType.ExecutionReopen;
    command.payload = { etapa: 'REPARO' };
    step.commandType = command.type;
    step.sequence = 3;
    manager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: Record<string, unknown> } | undefined)
        ?.where;
      if (entity === SagaStepEntity && where?.sequence)
        return Promise.resolve(null);
      if (entity === SagaStepEntity) return Promise.resolve(step);
      if (entity === SagaExecutionEntity) return Promise.resolve(execution);
      if (entity === SagaOutboxEntity)
        return Promise.resolve({
          commandId: ids.commandId,
          destination: 'EXECUCAO',
          body: command,
        });
      if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
      return Promise.resolve(null);
    });

    const processed = await transaction.processSagaResult(makeResult());

    expect(execution.status).toBe('COMPENSADA');
    expect(os.status).toBe(StatusOrdemServico.EmExecucao);
    expect(processed.statusChanges).toEqual([
      expect.objectContaining({
        statusAnterior: StatusOrdemServico.Finalizada,
        statusNovo: StatusOrdemServico.EmExecucao,
      }),
    ]);
  });

  it('marks a failed compensation for manual recovery and leaves the OS unchanged', async () => {
    os.status = StatusOrdemServico.Finalizada;
    execution.action = 'FINALIZAR';
    execution.status = 'COMPENSANDO';
    command.type = SagaCommandType.ExecutionReopen;
    command.payload = { etapa: 'REPARO' };
    step.commandType = command.type;
    step.sequence = 3;
    manager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: Record<string, unknown> } | undefined)
        ?.where;
      if (entity === SagaStepEntity && where?.sequence)
        return Promise.resolve(null);
      if (entity === SagaStepEntity) return Promise.resolve(step);
      if (entity === SagaExecutionEntity) return Promise.resolve(execution);
      if (entity === SagaOutboxEntity)
        return Promise.resolve({
          commandId: ids.commandId,
          destination: 'EXECUCAO',
          body: command,
        });
      if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
      return Promise.resolve(null);
    });

    await transaction.processSagaResult(
      makeResult({
        outcome: 'FALHA',
        payload: { code: 'REOPEN_ERROR', message: 'failed', retryable: false },
      }),
    );

    expect(execution.status).toBe('FALHA_COMPENSACAO');
    expect(os.status).toBe(StatusOrdemServico.Finalizada);
  });

  it.each(['COMPENSANDO', 'FALHA_COMPENSACAO'] as const)(
    'blocks another Saga while the current Saga is %s',
    async (status) => {
      execution.status = status;
      manager.findOne.mockImplementation(
        (entity: unknown, options?: unknown) => {
          if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
          if (entity === SagaExecutionEntity) {
            const query = options as { where: { status: { value: string[] } } };
            return Promise.resolve(
              query.where.status.value.includes(status) ? execution : null,
            );
          }
          return Promise.resolve(null);
        },
      );

      await expect(
        transaction.runInTransaction((tx) =>
          tx.lockOsAndEnsureNoActiveSaga(ids.osId),
        ),
      ).rejects.toThrow('Saga pendente');
    },
  );

  it('appends quote generation only after diagnosis completion succeeds', async () => {
    os.status = StatusOrdemServico.EmDiagnostico;
    execution.action = 'GERAR_ORCAMENTO';
    execution.context = { valorTotal: 125.5 };
    command.type = SagaCommandType.ExecutionComplete;
    command.payload = { etapa: 'DIAGNOSTICO' };
    step.commandType = command.type;
    step.destination = 'EXECUCAO';

    const processed = await transaction.processSagaResult(makeResult());

    expect(processed.statusChanges).toEqual([]);
    expect(os.status).toBe(StatusOrdemServico.EmDiagnostico);
    expect(execution.status).toBe('PENDENTE');
    expect(manager.save).toHaveBeenCalledWith(
      SagaStepEntity,
      expect.objectContaining({
        sequence: 2,
        commandType: SagaCommandType.BillingQuoteGenerate,
        status: 'PENDENTE',
      }),
    );
  });

  it('updates the canonical quote status only after Billing confirms generation', async () => {
    os.status = StatusOrdemServico.EmDiagnostico;
    execution.action = 'GERAR_ORCAMENTO';
    execution.context = { valorTotal: 125.5 };
    command.type = SagaCommandType.BillingQuoteGenerate;
    command.payload = { valorTotal: 125.5 };
    step.commandType = command.type;
    step.destination = 'BILLING';

    const processed = await transaction.processSagaResult(makeResult());

    expect(os.status).toBe(StatusOrdemServico.AguardandoAprovacao);
    expect(os.valorTotal).toBe(125.5);
    expect(processed.domainEvents).toContain('ORCAMENTO_GERADO');
  });

  it('marks FINALIZADA and appends payment opening after repair completion', async () => {
    os.status = StatusOrdemServico.EmExecucao;
    execution.action = 'FINALIZAR';
    execution.context = { valorTotal: 210 };
    command.type = SagaCommandType.ExecutionComplete;
    command.payload = { etapa: 'REPARO' };
    step.commandType = command.type;

    const processed = await transaction.processSagaResult(makeResult());

    expect(os.status).toBe(StatusOrdemServico.Finalizada);
    expect(execution.status).toBe('PENDENTE');
    expect(processed.statusChanges).toHaveLength(1);
    expect(manager.save).toHaveBeenCalledWith(
      SagaStepEntity,
      expect.objectContaining({
        sequence: 2,
        commandType: SagaCommandType.BillingPaymentOpen,
        status: 'PENDENTE',
      }),
    );
    expect(manager.create).toHaveBeenCalledWith(
      SagaOutboxEntity,
      expect.objectContaining({
        body: expect.objectContaining({
          type: SagaCommandType.BillingPaymentOpen,
          payload: { valorTotal: 210 },
          causationId: 'b34ac29e-dd88-4a8e-a5ab-79ed76f1fbc8',
        }),
      }),
    );
  });

  it('applies approval stock effects and both canonical status changes after Billing succeeds', async () => {
    os.status = StatusOrdemServico.AguardandoAprovacao;
    command.type = SagaCommandType.BillingQuoteApprove;
    command.payload = {};
    step.commandType = command.type;
    step.destination = 'BILLING';

    const processed = await transaction.processSagaResult(makeResult());

    expect(os.status).toBe(StatusOrdemServico.AguardandoServico);
    expect(processed.statusChanges).toHaveLength(2);
    expect(estoque.estoqueCobreReservaAtual).not.toHaveBeenCalled();
    expect(processed.domainEvents).toContain('ORCAMENTO_APROVADO');
  });

  it('treats the same committed result as a duplicate without reapplying the OS transition', async () => {
    step.status = 'CONCLUIDA';
    step.result = makeResult();

    const processed = await transaction.processSagaResult(makeResult());

    expect(processed).toEqual({
      duplicate: true,
      statusChanges: [],
      domainEvents: [],
    });
    expect(manager.findOne).not.toHaveBeenCalledWith(
      OrdemServicoTypeormEntity,
      expect.anything(),
    );
  });

  it('rejects a result whose causation does not match the published command', async () => {
    const result = makeResult({ causationId: 'wrong-message-id' });

    await expect(transaction.processSagaResult(result)).rejects.toThrow(
      'Correlação do resultado não corresponde ao comando',
    );
    expect(os.status).toBe(StatusOrdemServico.Recebida);
    expect(step.status).toBe('PENDENTE');
  });

  it('rejects a result when a previous sequence is not complete', async () => {
    step.sequence = 2;
    const predecessor = Object.assign(new SagaStepEntity(), {
      sagaId: ids.sagaId,
      sequence: 1,
      status: 'PENDENTE',
    });
    manager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const query = options as { where?: { sequence?: unknown } } | undefined;
      if (entity === SagaStepEntity && query?.where?.sequence)
        return Promise.resolve(predecessor);
      if (entity === SagaStepEntity) return Promise.resolve(step);
      if (entity === SagaExecutionEntity) return Promise.resolve(execution);
      if (entity === SagaOutboxEntity)
        return Promise.resolve({
          commandId: ids.commandId,
          destination: 'EXECUCAO',
          body: command,
        });
      if (entity === OrdemServicoTypeormEntity) return Promise.resolve(os);
      return Promise.resolve(null);
    });

    await expect(transaction.processSagaResult(makeResult())).rejects.toThrow(
      'etapa anterior',
    );

    expect(os.status).toBe(StatusOrdemServico.Recebida);
    expect(step.status).toBe('PENDENTE');
    expect(manager.save).not.toHaveBeenCalled();
  });
});
