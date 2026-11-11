import {
  ConflictError,
  NotFoundError,
} from '../../../common/application/errors/application.errors';
import { DataSource, EntityManager } from 'typeorm';
import { ClienteTransactionalPort } from '../../../clientes/application/ports/cliente-transactional.port';
import { EstoqueTransactionalPort } from '../../../estoque/application/ports/estoque-transactional.port';
import { ServicoTransactionalPort } from '../../../servicos/application/ports/servico-transactional.port';
import { VeiculoTransactionalPort } from '../../../veiculos/application/ports/veiculo-transactional.port';
import { StatusOrdemServico } from '../../domain/status-ordem-servico.enum';
import { ItemOsEstoqueEntity } from '../typeorm/entity/item-os-estoque.entity';
import { ItemOsServicoEntity } from '../typeorm/entity/item-os-servico.entity';
import { OrdemServicoTypeormEntity } from '../typeorm/entity/ordem-servico.typeorm.entity';
import { OrdemServicoTypeormTransaction } from './ordem-servico.typeorm-transaction';
import {
  SagaCommandMessage,
  SagaCommandType,
} from '../../../saga/contracts/saga-message';
import { SagaExecutionEntity } from '../../../saga/persistence/saga-execution.entity';
import { SagaOutboxEntity } from '../../../saga/persistence/saga-outbox.entity';
import { SagaStepEntity } from '../../../saga/persistence/saga-step.entity';

describe('OrdemServicoTypeormTransaction', () => {
  let transaction: OrdemServicoTypeormTransaction;
  let em: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    softRemove: jest.Mock;
  };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: EntityManager;
  };
  let dataSource: { createQueryRunner: jest.Mock };
  let clienteTransactional: jest.Mocked<ClienteTransactionalPort>;
  let veiculoTransactional: jest.Mocked<VeiculoTransactionalPort>;
  let servicoTransactional: jest.Mocked<ServicoTransactionalPort>;
  let estoqueTransactional: jest.Mocked<EstoqueTransactionalPort>;

  beforeEach(() => {
    em = {
      create: jest.fn(
        (_entity: unknown, data: Record<string, unknown>) => data,
      ),
      save: jest.fn((_entity: unknown, data: unknown) => Promise.resolve(data)),
      findOne: jest.fn(),
      softRemove: jest.fn().mockResolvedValue(undefined),
    };

    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: em as unknown as EntityManager,
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };

    clienteTransactional = { findIdByDocumento: jest.fn() };
    veiculoTransactional = { findIdForCliente: jest.fn() };
    servicoTransactional = {
      findPreco: jest.fn().mockResolvedValue({
        servicoId: 1,
        precoAplicado: 100,
      }),
    };
    estoqueTransactional = {
      reservarParaOrdemServico: jest.fn().mockResolvedValue({
        estoqueId: 5,
        precoAplicado: 50,
        disponivelNoDiagnostico: true,
        precisaObservacaoCompra: false,
      }),
      estornarReservas: jest.fn().mockResolvedValue(undefined),
      estoqueCobreReservaAtual: jest.fn().mockResolvedValue(true),
      darBaixaEmExecucao: jest.fn().mockResolvedValue(undefined),
    };

    transaction = new OrdemServicoTypeormTransaction(
      dataSource as unknown as DataSource,
      clienteTransactional,
      veiculoTransactional,
      servicoTransactional,
      estoqueTransactional,
    );
  });

  const inTransaction = <T>(
    work: (tx: OrdemServicoTypeormTransaction) => Promise<T>,
  ) => transaction.runInTransaction(work);

  const makeOs = (
    overrides: Partial<OrdemServicoTypeormEntity> = {},
  ): OrdemServicoTypeormEntity =>
    Object.assign(new OrdemServicoTypeormEntity(), {
      id: 'os-1',
      status: StatusOrdemServico.Recebida,
      valorTotal: 0,
      observacao: null,
      itensServico: [],
      itensPeca: [],
      ...overrides,
    });

  it('runInTransaction faz commit em sucesso', async () => {
    await expect(inTransaction(() => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  const makeSagaCommand = (): SagaCommandMessage => ({
    messageId: '7d9f9748-b2d2-46ab-8106-fd5dad738b19',
    commandId: 'a707820e-fbe3-483a-b5ae-3a69a3eb947c',
    sagaId: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
    osId: '9abeb153-d57f-4a92-b32a-918fc9e4abc0',
    occurredAt: '2026-11-07T12:00:00.000Z',
    correlationId: 'request-1',
    causationId: null,
    schemaVersion: 1,
    type: SagaCommandType.BillingQuoteGenerate,
    payload: { valorTotal: 125.5 },
  });

  const makeSagaStep = (command: SagaCommandMessage) => ({
    command,
    sequence: 1,
    destination: 'BILLING' as const,
  });

  const makeSagaExecution = (osId: string) =>
    Object.assign(new SagaExecutionEntity(), {
      id: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
      osId,
      status: 'PENDENTE',
    });

  it('runInTransaction faz rollback em erro', async () => {
    await expect(
      inTransaction(() => Promise.reject(new Error('falha'))),
    ).rejects.toThrow('falha');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('mantém o EntityManager isolado entre transações concorrentes', async () => {
    let releaseFirst!: () => void;
    let markFirstLoaded!: () => void;
    const firstLoaded = new Promise<void>((resolve) => {
      markFirstLoaded = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    em.findOne.mockResolvedValue(makeOs());

    const first = inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', {});
      markFirstLoaded();
      await firstGate;
      return tx.saveOs(handle);
    });
    await firstLoaded;

    const secondManager = {
      ...em,
      findOne: jest.fn().mockResolvedValue(makeOs({ id: 'os-2' })),
      save: jest.fn((_entity: unknown, data: unknown) => Promise.resolve(data)),
    };
    const secondQueryRunner = {
      ...queryRunner,
      manager: secondManager as unknown as EntityManager,
    };
    dataSource.createQueryRunner.mockReturnValueOnce(secondQueryRunner);

    await transaction.runInTransaction((tx) => tx.loadOs('os-2', {}));
    releaseFirst();

    await expect(first).resolves.toMatchObject({ id: 'os-1' });
    expect(em.save).toHaveBeenCalledWith(
      OrdemServicoTypeormEntity,
      expect.objectContaining({ id: 'os-1' }),
    );
    expect(secondManager.save).not.toHaveBeenCalled();
  });

  it('persiste execução, etapa e outbox em conjunto ao criar uma Saga', async () => {
    const command = makeSagaCommand();
    em.findOne
      .mockResolvedValueOnce(makeSagaExecution(command.osId))
      .mockResolvedValueOnce(null);

    await inTransaction((tx) =>
      tx.createSagaCommand({
        execution: {
          id: command.sagaId,
          osId: command.osId,
          action: 'GERAR_ORCAMENTO',
          requestedBy: 'cd120ff9-8861-4751-90d1-a89bc90411f4',
        },
        step: makeSagaStep(command),
      }),
    );

    expect(em.save).toHaveBeenNthCalledWith(
      1,
      SagaExecutionEntity,
      expect.objectContaining({ id: command.sagaId, osId: command.osId }),
    );
    expect(em.save).toHaveBeenNthCalledWith(
      2,
      SagaStepEntity,
      expect.objectContaining({ commandId: command.commandId, sequence: 1 }),
    );
    expect(em.save).toHaveBeenNthCalledWith(
      3,
      SagaOutboxEntity,
      expect.objectContaining({
        messageId: command.messageId,
        commandId: command.commandId,
        body: command,
      }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('serializa uma ação Saga bloqueando a OS antes de verificar execuções ativas', async () => {
    em.findOne.mockImplementation((entity: unknown) => {
      if (entity === OrdemServicoTypeormEntity)
        return Promise.resolve(makeOs());
      return Promise.resolve(null);
    });

    await inTransaction((tx) => tx.lockOsAndEnsureNoActiveSaga('os-1'));

    expect(em.findOne).toHaveBeenNthCalledWith(
      1,
      OrdemServicoTypeormEntity,
      expect.objectContaining({
        where: { id: 'os-1' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(em.findOne).toHaveBeenNthCalledWith(
      2,
      SagaExecutionEntity,
      expect.objectContaining({
        where: expect.objectContaining({ osId: 'os-1' }),
      }),
    );
  });

  it.each(['PENDENTE', 'EM_PROCESSAMENTO'] as const)(
    'rejeita e faz rollback quando já existe Saga %s para a OS',
    async (status) => {
      em.findOne.mockImplementation((entity: unknown) => {
        if (entity === OrdemServicoTypeormEntity)
          return Promise.resolve(makeOs());
        if (entity === SagaExecutionEntity)
          return Promise.resolve({ osId: 'os-1', status });
        return Promise.resolve(null);
      });

      await expect(
        inTransaction((tx) => tx.lockOsAndEnsureNoActiveSaga('os-1')),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(em.save).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    },
  );

  it('permite uma nova ação após execução terminal em falha', async () => {
    em.findOne.mockImplementation((entity: unknown) => {
      if (entity === OrdemServicoTypeormEntity)
        return Promise.resolve(makeOs());
      return Promise.resolve(null);
    });

    await expect(
      inTransaction((tx) => tx.lockOsAndEnsureNoActiveSaga('os-1')),
    ).resolves.toBeUndefined();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('exige sequência 1 ao criar a primeira etapa', async () => {
    const command = makeSagaCommand();
    em.findOne
      .mockResolvedValueOnce(makeSagaExecution(command.osId))
      .mockResolvedValueOnce(null);

    await expect(
      inTransaction((tx) =>
        tx.createSagaCommand({
          execution: {
            id: command.sagaId,
            osId: command.osId,
            action: 'GERAR_ORCAMENTO',
            requestedBy: null,
          },
          step: { ...makeSagaStep(command), sequence: 2 },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(em.save).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('não anexa etapa quando a anterior ainda está pendente', async () => {
    const command = makeSagaCommand();
    em.findOne
      .mockResolvedValueOnce(makeSagaExecution(command.osId))
      .mockResolvedValueOnce({ sequence: 1, status: 'PENDENTE' });

    await expect(
      inTransaction((tx) =>
        tx.appendSagaCommand({
          sagaId: command.sagaId,
          step: { ...makeSagaStep(command), sequence: 2 },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(em.save).not.toHaveBeenCalled();
  });

  it('rejeita salto na sequência de etapas', async () => {
    const command = makeSagaCommand();
    em.findOne
      .mockResolvedValueOnce(makeSagaExecution(command.osId))
      .mockResolvedValueOnce({ sequence: 1, status: 'CONCLUIDA' });

    await expect(
      inTransaction((tx) =>
        tx.appendSagaCommand({
          sagaId: command.sagaId,
          step: { ...makeSagaStep(command), sequence: 3 },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(em.save).not.toHaveBeenCalled();
  });

  it('rolls back all Saga rows when the outbox insert fails', async () => {
    const command = makeSagaCommand();
    em.findOne
      .mockResolvedValueOnce(makeSagaExecution(command.osId))
      .mockResolvedValueOnce(null);
    em.save
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('outbox insert failed'));

    await expect(
      inTransaction((tx) =>
        tx.createSagaCommand({
          execution: {
            id: command.sagaId,
            osId: command.osId,
            action: 'GERAR_ORCAMENTO',
            requestedBy: 'cd120ff9-8861-4751-90d1-a89bc90411f4',
          },
          step: makeSagaStep(command),
        }),
      ),
    ).rejects.toThrow('outbox insert failed');

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('acrescenta etapa e outbox a uma Saga sem criar nova execução', async () => {
    const command = makeSagaCommand();
    em.findOne
      .mockResolvedValueOnce(makeSagaExecution(command.osId))
      .mockResolvedValueOnce({ sequence: 1, status: 'CONCLUIDA' });

    await inTransaction((tx) =>
      tx.appendSagaCommand({
        sagaId: command.sagaId,
        step: { ...makeSagaStep(command), sequence: 2 },
      }),
    );

    expect(em.save).toHaveBeenCalledTimes(2);
    expect(em.save).toHaveBeenNthCalledWith(
      1,
      SagaStepEntity,
      expect.objectContaining({ sagaId: command.sagaId, sequence: 2 }),
    );
    expect(em.save).toHaveBeenNthCalledWith(
      2,
      SagaOutboxEntity,
      expect.objectContaining({ commandId: command.commandId }),
    );
  });

  it('manager lança erro fora de transação', () => {
    expect(() =>
      (transaction as unknown as { manager: () => EntityManager }).manager(),
    ).toThrow('Transação de ordem de serviço não iniciada.');
  });

  it('delega findClienteIdByDocumento', async () => {
    clienteTransactional.findIdByDocumento.mockResolvedValue('cli-1');

    await expect(
      inTransaction((tx) => tx.findClienteIdByDocumento('39053344705')),
    ).resolves.toBe('cli-1');
  });

  it('buildItensServico monta drafts com preço', async () => {
    const result = await inTransaction((tx) =>
      tx.buildItensServico([{ servicoId: 1 }]),
    );

    expect(result).toEqual([{ servicoId: 1, precoAplicado: 100 }]);
  });

  it('buildItensPecaWithReserva agrega flag de observação de compra', async () => {
    estoqueTransactional.reservarParaOrdemServico
      .mockResolvedValueOnce({
        estoqueId: 5,
        precoAplicado: 50,
        disponivelNoDiagnostico: true,
        precisaObservacaoCompra: false,
      })
      .mockResolvedValueOnce({
        estoqueId: 6,
        precoAplicado: 30,
        disponivelNoDiagnostico: false,
        precisaObservacaoCompra: true,
      });

    const result = await inTransaction((tx) =>
      tx.buildItensPecaWithReserva([
        { estoqueId: 5, quantidade: 1 },
        { estoqueId: 6, quantidade: 2 },
      ]),
    );

    expect(result.pecaPrecisaObservacaoCompra).toBe(true);
    expect(result.itens).toHaveLength(2);
  });

  it('insertNewOs persiste OS e calcula valor total', async () => {
    const saved = makeOs({ valorTotal: 200 });
    em.save.mockResolvedValue(saved);

    const readModel = await inTransaction((tx) =>
      tx.insertNewOs({
        clienteId: 'cli-1',
        veiculoId: 'vei-1',
        observacao: 'obs',
        itensServico: [{ servicoId: 1, precoAplicado: 100 }],
        itensPeca: [
          {
            estoqueId: 5,
            quantidade: 2,
            precoAplicado: 50,
            disponivelNoDiagnostico: true,
          },
        ],
      }),
    );

    expect(readModel.id).toBe('os-1');
    expect(em.save).toHaveBeenCalled();
  });

  it('loadOs lança NotFoundError quando OS não existe', async () => {
    em.findOne.mockResolvedValue(null);

    await expect(
      inTransaction((tx) => tx.loadOs('missing', {})),
    ).rejects.toThrow(NotFoundError);
  });

  it('delega findVeiculoIdForCliente', async () => {
    veiculoTransactional.findIdForCliente.mockResolvedValue('vei-1');

    await expect(
      inTransaction((tx) => tx.findVeiculoIdForCliente('ABC1D23', 'cli-1')),
    ).resolves.toBe('vei-1');
  });

  it('loadOs handle expõe observacao mutável', async () => {
    em.findOne.mockResolvedValue(makeOs());

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', {});
      expect(handle.observacao).toBeNull();
      handle.observacao = 'Nova obs';
      expect(handle.observacao).toBe('Nova obs');
    });
  });

  it('loadOs retorna handle que avança status e calcula valor', async () => {
    const os = makeOs({
      itensServico: [{ precoAplicado: 80 } as ItemOsServicoEntity],
      itensPeca: [
        {
          precoAplicado: 10,
          quantidade: 2,
          disponivelNoDiagnostico: true,
        } as ItemOsEstoqueEntity,
      ],
    });
    em.findOne.mockResolvedValue(os);

    const handle = await inTransaction((tx) =>
      tx.loadOs('os-1', { itensServico: true, itensPeca: true }),
    );

    expect(handle.calcularValorTotal()).toBe(100);
    expect(handle.todasPecasDisponiveis()).toBe(true);
    handle.avancarStatus(StatusOrdemServico.EmDiagnostico);
    expect(handle.status).toBe(StatusOrdemServico.EmDiagnostico);
  });

  it('saveOs persiste handle e retorna read model', async () => {
    const os = makeOs();
    em.findOne.mockResolvedValue(os);
    em.save.mockResolvedValue(os);

    const readModel = await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', {});
      return tx.saveOs(handle);
    });

    expect(readModel.id).toBe('os-1');
  });

  it('softRemoveOsItens remove itens quando existem', async () => {
    const os = makeOs({
      itensServico: [{} as ItemOsServicoEntity],
      itensPeca: [{} as ItemOsEstoqueEntity],
    });
    em.findOne.mockResolvedValue(os);

    await inTransaction((tx) => tx.softRemoveOsItens('os-1'));

    expect(em.softRemove).toHaveBeenCalledTimes(2);
  });

  it('softRemoveOsItens ignora listas vazias', async () => {
    em.findOne.mockResolvedValue(makeOs());

    await inTransaction((tx) => tx.softRemoveOsItens('os-1'));

    expect(em.softRemove).not.toHaveBeenCalled();
  });

  it('refreshValorTotal atualiza valor no handle', async () => {
    const os = makeOs({
      itensServico: [{ precoAplicado: 150 } as ItemOsServicoEntity],
    });
    em.findOne.mockResolvedValue(os);

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensServico: true });
      tx.refreshValorTotal(handle);
      expect(handle.valorTotal).toBe(150);
    });
  });

  it('syncPecaDisponibilidadeAposAprovacao marca peça disponível', async () => {
    const peca = {
      id: 'ip-1',
      estoque_id: 5,
      disponivelNoDiagnostico: false,
    } as ItemOsEstoqueEntity;
    const os = makeOs({ itensPeca: [peca] });
    em.findOne.mockResolvedValue(os);

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.syncPecaDisponibilidadeAposAprovacao(handle);
      expect(peca.disponivelNoDiagnostico).toBe(true);
      expect(em.save).toHaveBeenCalledWith(ItemOsEstoqueEntity, peca);
    });
  });

  it('syncPecaDisponibilidadeAposAprovacao ignora peça já disponível', async () => {
    const peca = {
      id: 'ip-1',
      estoque_id: 5,
      disponivelNoDiagnostico: true,
    } as ItemOsEstoqueEntity;
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [peca] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.syncPecaDisponibilidadeAposAprovacao(handle);
      expect(
        estoqueTransactional.estoqueCobreReservaAtual,
      ).not.toHaveBeenCalled();
    });
  });

  it('darBaixaPecasEmExecucao delega ao port de estoque', async () => {
    const peca = {
      estoque_id: 5,
      quantidade: 2,
      disponivelNoDiagnostico: true,
    } as ItemOsEstoqueEntity;
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [peca] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.darBaixaPecasEmExecucao(handle);
      expect(estoqueTransactional.darBaixaEmExecucao).toHaveBeenCalledWith(
        em,
        5,
        2,
      );
    });
  });

  it('estornarReservasAoReprovar delega ao port de estoque', async () => {
    const peca = {
      estoque_id: 5,
      quantidade: 3,
    } as ItemOsEstoqueEntity;
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [peca] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.estornarReservasAoReprovar(handle);
      expect(estoqueTransactional.estornarReservas).toHaveBeenCalledWith(em, [
        { estoqueId: 5, quantidade: 3 },
      ]);
    });
  });

  it('loadOsAguardandoPecasForUpdate retorna null quando não encontra', async () => {
    em.findOne.mockResolvedValue(null);

    await expect(
      inTransaction((tx) => tx.loadOsAguardandoPecasForUpdate('os-1')),
    ).resolves.toBeNull();
  });

  it('loadOsAguardandoPecasForUpdate retorna handle quando encontra', async () => {
    const os = makeOs({ status: StatusOrdemServico.AguardandoPecasInsumos });
    em.findOne.mockResolvedValue(os);

    const handle = await inTransaction((tx) =>
      tx.loadOsAguardandoPecasForUpdate('os-1'),
    );

    expect(handle?.status).toBe(StatusOrdemServico.AguardandoPecasInsumos);
  });

  it('syncPecasPendentesAposReposicao marca peça quando estoque cobre', async () => {
    const peca = {
      id: 'ip-1',
      estoque_id: 5,
      disponivelNoDiagnostico: false,
    } as ItemOsEstoqueEntity;
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [peca] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.syncPecasPendentesAposReposicao(handle);
      expect(peca.disponivelNoDiagnostico).toBe(true);
    });
  });

  it('syncPecaDisponibilidadeAposAprovacao ignora quando estoque não cobre', async () => {
    estoqueTransactional.estoqueCobreReservaAtual.mockResolvedValue(false);
    const peca = {
      id: 'ip-1',
      estoque_id: 5,
      disponivelNoDiagnostico: false,
    } as ItemOsEstoqueEntity;
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [peca] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.syncPecaDisponibilidadeAposAprovacao(handle);
      expect(peca.disponivelNoDiagnostico).toBe(false);
      expect(em.save).not.toHaveBeenCalled();
    });
  });

  it('syncPecasPendentesAposReposicao ignora peça já disponível', async () => {
    const peca = {
      id: 'ip-1',
      estoque_id: 5,
      disponivelNoDiagnostico: true,
    } as ItemOsEstoqueEntity;
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [peca] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      await tx.syncPecasPendentesAposReposicao(handle);
      expect(
        estoqueTransactional.estoqueCobreReservaAtual,
      ).not.toHaveBeenCalled();
    });
  });

  it('syncPecasPendentesAposReposicao ignora quando peça não está na entidade', async () => {
    em.findOne.mockResolvedValue(makeOs({ itensPeca: [] }));

    await inTransaction(async (tx) => {
      const handle = await tx.loadOs('os-1', { itensPeca: true });
      Object.defineProperty(handle, 'itensPeca', {
        value: [
          {
            id: 'missing',
            estoqueId: 5,
            quantidade: 1,
            disponivelNoDiagnostico: false,
          },
        ],
      });
      await tx.syncPecasPendentesAposReposicao(handle);
      expect(
        estoqueTransactional.estoqueCobreReservaAtual,
      ).not.toHaveBeenCalled();
    });
  });

  it('replaceItensInDiagnostico substitui itens e recalcula valor', async () => {
    const os = makeOs({
      observacao: 'Antiga',
      itensServico: [{ servico_id: 1 } as ItemOsServicoEntity],
      itensPeca: [{ estoque_id: 5, quantidade: 1 } as ItemOsEstoqueEntity],
    });
    em.findOne.mockResolvedValue(os);

    await inTransaction((tx) =>
      tx.replaceItensInDiagnostico('os-1', {
        itensServico: [{ servicoId: 2 }],
        itensPeca: [{ estoqueId: 6, quantidade: 1 }],
      }),
    );

    expect(estoqueTransactional.estornarReservas).toHaveBeenCalled();
    expect(em.softRemove).toHaveBeenCalled();
    expect(em.save).toHaveBeenCalledWith(
      OrdemServicoTypeormEntity,
      expect.objectContaining({ id: 'os-1' }),
    );
  });
});
