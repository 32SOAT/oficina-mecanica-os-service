import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
} from '../../../common/application/errors/application.errors';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Not } from 'typeorm';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CLIENTE_TRANSACTIONAL_PORT,
  ClienteTransactionalPort,
} from '../../../clientes/application/ports/cliente-transactional.port';
import {
  ESTOQUE_TRANSACTIONAL_PORT,
  EstoqueTransactionalPort,
} from '../../../estoque/application/ports/estoque-transactional.port';
import {
  SERVICO_TRANSACTIONAL_PORT,
  ServicoTransactionalPort,
} from '../../../servicos/application/ports/servico-transactional.port';
import {
  VEICULO_TRANSACTIONAL_PORT,
  VeiculoTransactionalPort,
} from '../../../veiculos/application/ports/veiculo-transactional.port';
import {
  EditarItensOsInput,
  OrdemServicoReadModel,
} from '../../application/dto/ordem-servico.dto';
import {
  OrdemServicoTransactionPort,
  OrdemServicoTransactionalOperations,
  AppendSagaCommandInput,
  CreateSagaCommandInput,
  SagaResultProcessing,
  SagaStatusQuery,
  OsPecaItemDraft,
  OsPecaItemState,
  OsServicoItemDraft,
  OsWorkflowHandle,
} from '../../application/ports/ordem-servico-transaction.port';
import {
  avancarStatusOrdemServico,
  calcularValorTotalOrdemServico,
  todasPecasDisponiveis,
} from '../../domain/ordem-servico';
import { mergeObservacaoAvisoCompra } from '../../domain/observacao-compra';
import { quantidadeParaBaixaEmExecucao } from '../../domain/reserva-peca';
import { StatusOrdemServico } from '../../domain/status-ordem-servico.enum';
import { OrdemServicoReadModelMapper } from '../mappers/ordem-servico-read-model.mapper';
import { ItemOsEstoqueEntity } from '../typeorm/entity/item-os-estoque.entity';
import { ItemOsServicoEntity } from '../typeorm/entity/item-os-servico.entity';
import { OrdemServicoTypeormEntity } from '../typeorm/entity/ordem-servico.typeorm.entity';
import { SagaExecutionEntity } from '../../../saga/persistence/saga-execution.entity';
import { SagaOutboxEntity } from '../../../saga/persistence/saga-outbox.entity';
import { SagaStepEntity } from '../../../saga/persistence/saga-step.entity';
import {
  SagaCommandMessage,
  SagaCommandType,
  SagaExecutionStatus,
  SagaResultMessage,
} from '../../../saga/contracts/saga-message';
import { HistoricoStatusOsEntity } from '../typeorm/entity/historico-status-os.entity';

class OsTypeormHandle implements OsWorkflowHandle {
  constructor(readonly entity: OrdemServicoTypeormEntity) {}

  get id(): string {
    return this.entity.id;
  }

  get status(): StatusOrdemServico {
    return this.entity.status;
  }

  get observacao(): string | null {
    return this.entity.observacao;
  }

  set observacao(value: string | null) {
    this.entity.observacao = value;
  }

  get valorTotal(): number {
    return Number(this.entity.valorTotal);
  }

  set valorTotal(value: number) {
    this.entity.valorTotal = value;
  }

  get itensPeca(): OsPecaItemState[] {
    return (this.entity.itensPeca ?? []).map((item) => ({
      id: item.id,
      estoqueId: item.estoque_id,
      quantidade: item.quantidade,
      disponivelNoDiagnostico: item.disponivelNoDiagnostico,
    }));
  }

  avancarStatus(para: StatusOrdemServico) {
    const result = avancarStatusOrdemServico(this.entity.status, para);
    this.entity.status = result.novo;
    return result;
  }

  calcularValorTotal(): number {
    return calcularValorTotalOrdemServico(
      this.entity.itensServico ?? [],
      this.entity.itensPeca ?? [],
    );
  }

  todasPecasDisponiveis(): boolean {
    return todasPecasDisponiveis(this.entity.itensPeca ?? []);
  }
}

@Injectable()
export class OrdemServicoTypeormTransaction
  implements OrdemServicoTransactionPort, OrdemServicoTransactionalOperations
{
  private readonly entityManagerContext =
    new AsyncLocalStorage<EntityManager>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLIENTE_TRANSACTIONAL_PORT)
    private readonly clienteTransactional: ClienteTransactionalPort,
    @Inject(VEICULO_TRANSACTIONAL_PORT)
    private readonly veiculoTransactional: VeiculoTransactionalPort,
    @Inject(SERVICO_TRANSACTIONAL_PORT)
    private readonly servicoTransactional: ServicoTransactionalPort,
    @Inject(ESTOQUE_TRANSACTIONAL_PORT)
    private readonly estoqueTransactional: EstoqueTransactionalPort,
  ) {}

  async runInTransaction<T>(
    work: (operations: OrdemServicoTransactionalOperations) => Promise<T>,
  ): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const result = await this.entityManagerContext.run(qr.manager, () =>
        work(this),
      );
      await qr.commitTransaction();
      return result;
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  private manager(): EntityManager {
    const manager = this.entityManagerContext.getStore();
    if (!manager) {
      throw new Error('Transação de ordem de serviço não iniciada.');
    }
    return manager;
  }

  private toReadModel(
    entity: OrdemServicoTypeormEntity,
  ): OrdemServicoReadModel {
    return OrdemServicoReadModelMapper.toReadModel(entity);
  }

  private wrap(entity: OrdemServicoTypeormEntity): OsTypeormHandle {
    return new OsTypeormHandle(entity);
  }

  async lockOsAndEnsureNoActiveSaga(osId: string): Promise<void> {
    const manager = this.manager();
    const os = await manager.findOne(OrdemServicoTypeormEntity, {
      where: { id: osId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!os) throw new NotFoundError('Ordem de serviço não encontrada.');

    const activeExecution = await manager.findOne(SagaExecutionEntity, {
      where: {
        osId,
        status: In([
          'PENDENTE',
          'EM_PROCESSAMENTO',
          'COMPENSANDO',
          'FALHA_COMPENSACAO',
        ]),
      },
    });
    if (activeExecution) {
      throw new ConflictError(
        'Já existe uma operação Saga pendente para esta ordem de serviço.',
      );
    }
  }

  async createSagaCommand(input: CreateSagaCommandInput): Promise<void> {
    const { execution, step } = input;
    if (
      execution.id !== step.command.sagaId ||
      execution.osId !== step.command.osId
    ) {
      throw new Error('Comando da Saga não corresponde à execução informada.');
    }

    const executionEntity = this.manager().create(SagaExecutionEntity, {
      id: execution.id,
      osId: execution.osId,
      action: execution.action,
      requestedBy: execution.requestedBy,
      context: execution.context ?? {},
      status: 'PENDENTE',
    });
    await this.manager().save(SagaExecutionEntity, executionEntity);
    await this.saveSagaStepAndOutbox(execution.id, step);
  }

  async appendSagaCommand(input: AppendSagaCommandInput): Promise<void> {
    await this.saveSagaStepAndOutbox(input.sagaId, input.step);
  }

  async processSagaResult(
    result: SagaResultMessage,
  ): Promise<SagaResultProcessing> {
    return this.runInTransaction(async () => this.applySagaResult(result));
  }

  async findSagaStatus(
    osId: string,
    sagaId: string,
  ): Promise<SagaStatusQuery | null> {
    const execution = await this.dataSource
      .getRepository(SagaExecutionEntity)
      .findOne({ where: { id: sagaId, osId } });
    if (!execution) return null;
    const steps = await this.dataSource.getRepository(SagaStepEntity).find({
      where: { sagaId },
      order: { sequence: 'ASC' },
    });
    return {
      sagaId: execution.id,
      osId: execution.osId,
      action: execution.action,
      status: execution.status,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      steps: steps.map((step) => ({
        commandId: step.commandId,
        sequence: step.sequence,
        commandType: step.commandType,
        status: step.status,
        attemptCount: step.attemptCount,
        retryable: step.retryable,
        lastErrorCode: step.lastErrorCode,
        lastErrorMessage: step.lastErrorMessage,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
        completedAt: step.completedAt,
      })),
    };
  }

  private async applySagaResult(
    result: SagaResultMessage,
  ): Promise<SagaResultProcessing> {
    const manager = this.manager();
    const step = await manager.findOne(SagaStepEntity, {
      where: { commandId: result.commandId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!step) throw new Error('Etapa da Saga não encontrada');
    if (step.sagaId !== result.sagaId) {
      throw new Error('sagaId do resultado não corresponde à etapa');
    }
    const execution = await manager.findOne(SagaExecutionEntity, {
      where: { id: result.sagaId, osId: result.osId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!execution) throw new Error('Execução da Saga não encontrada');
    const outbox = await manager.findOne(SagaOutboxEntity, {
      where: { commandId: result.commandId },
    });
    if (!outbox) throw new Error('Comando original da Saga não encontrado');
    const command =
      typeof outbox.body === 'string'
        ? (JSON.parse(outbox.body) as SagaCommandMessage)
        : outbox.body;
    const expectedDestination = command.type.startsWith('BILLING_')
      ? 'BILLING'
      : 'EXECUCAO';
    if (
      command.sagaId !== result.sagaId ||
      command.osId !== result.osId ||
      step.commandType !== command.type ||
      outbox.destination !== expectedDestination ||
      command.correlationId !== result.correlationId ||
      command.messageId !== result.causationId
    ) {
      throw new Error('Correlação do resultado não corresponde ao comando');
    }

    if (step.status === 'CONCLUIDA' || step.status === 'FALHA') {
      if (!this.sameSagaResult(step.result, result)) {
        throw new Error('Resultado conflitante para etapa já encerrada');
      }
      return { duplicate: true, statusChanges: [], domainEvents: [] };
    }
    if (step.status !== 'PENDENTE' && step.status !== 'EM_PROCESSAMENTO') {
      throw new Error('Estado da etapa não aceita resultado');
    }
    if (step.sequence > 1) {
      const incompletePreviousStep = await manager.findOne(SagaStepEntity, {
        where: {
          sagaId: step.sagaId,
          sequence: LessThan(step.sequence),
          status: Not('CONCLUIDA'),
        },
      });
      const expectedFailedPredecessor =
        command.type === SagaCommandType.ExecutionReopen &&
        incompletePreviousStep?.sequence === step.sequence - 1 &&
        incompletePreviousStep.status === 'FALHA';
      if (incompletePreviousStep && !expectedFailedPredecessor) {
        throw new ConflictError(
          'Resultado fora de sequência: há uma etapa anterior não concluída.',
        );
      }
    }

    const processing: SagaResultProcessing = {
      duplicate: false,
      statusChanges: [],
      domainEvents: [],
    };
    step.result = result;
    step.attemptCount += 1;
    step.completedAt = new Date();
    if (result.outcome === 'FALHA') {
      step.status = 'FALHA';
      step.retryable = result.payload.retryable;
      step.lastErrorCode = result.payload.code;
      step.lastErrorMessage = result.payload.message;
      const compensationStage =
        command.type === SagaCommandType.BillingQuoteGenerate &&
        execution.action === 'GERAR_ORCAMENTO' &&
        step.sequence === 2
          ? 'DIAGNOSTICO'
          : command.type === SagaCommandType.BillingPaymentOpen &&
              execution.action === 'FINALIZAR' &&
              step.sequence === 2
            ? 'REPARO'
            : null;
      execution.status =
        command.type === SagaCommandType.ExecutionReopen
          ? SagaExecutionStatus.FalhaCompensacao
          : compensationStage
            ? SagaExecutionStatus.Compensando
            : SagaExecutionStatus.Falha;
      await manager.save(SagaStepEntity, step);
      await manager.save(SagaExecutionEntity, execution);
      if (compensationStage) {
        await this.appendSagaCommand({
          sagaId: execution.id,
          step: {
            sequence: step.sequence + 1,
            destination: 'EXECUCAO',
            command: {
              messageId: randomUUID(),
              commandId: randomUUID(),
              sagaId: result.sagaId,
              osId: result.osId,
              occurredAt: new Date().toISOString(),
              correlationId: result.correlationId,
              causationId: result.messageId,
              schemaVersion: 1,
              type: SagaCommandType.ExecutionReopen,
              payload: { etapa: compensationStage },
            },
          },
        });
      }
      return processing;
    }

    step.status = 'CONCLUIDA';
    step.retryable = false;
    step.lastErrorCode = null;
    step.lastErrorMessage = null;
    const osId = result.osId;
    const usuarioId = execution.requestedBy;
    let hasNextStep = false;

    switch (command.type) {
      case SagaCommandType.ExecutionReopen:
        if (execution.status !== SagaExecutionStatus.Compensando) {
          throw new ConflictError('Saga não está aguardando compensação.');
        }
        if (command.payload.etapa === 'REPARO') {
          const os = await this.loadOs(osId, {});
          if (os.status !== StatusOrdemServico.Finalizada) {
            throw new ConflictError(
              'Status da OS incompatível com compensação do reparo.',
            );
          }
          (os as OsTypeormHandle).entity.status = StatusOrdemServico.EmExecucao;
          await this.saveOs(os);
          await this.saveSagaHistory(
            osId,
            StatusOrdemServico.Finalizada,
            StatusOrdemServico.EmExecucao,
            usuarioId,
          );
          processing.statusChanges.push({
            osId,
            statusAnterior: StatusOrdemServico.Finalizada,
            statusNovo: StatusOrdemServico.EmExecucao,
            usuarioId,
          });
        }
        break;
      case SagaCommandType.ExecutionOpen:
        if (command.payload.etapa === 'DIAGNOSTICO') {
          processing.statusChanges.push(
            await this.recordSagaStatusTransition(
              osId,
              StatusOrdemServico.EmDiagnostico,
              usuarioId,
            ),
          );
        } else {
          const os = await this.loadOs(osId, { itensPeca: true });
          const { anterior, novo } = os.avancarStatus(
            StatusOrdemServico.EmExecucao,
          );
          await this.darBaixaPecasEmExecucao(os);
          await this.saveOs(os);
          await this.saveSagaHistory(osId, anterior, novo, usuarioId);
          processing.statusChanges.push({
            osId,
            statusAnterior: anterior,
            statusNovo: novo,
            usuarioId,
          });
          processing.domainEvents.push('EXECUCAO_INICIADA');
        }
        break;
      case SagaCommandType.ExecutionComplete:
        if (command.payload.etapa === 'DIAGNOSTICO') {
          await this.appendSagaCommand({
            sagaId: execution.id,
            step: {
              sequence: step.sequence + 1,
              destination: 'BILLING',
              command: this.createChainedCommand(
                result,
                SagaCommandType.BillingQuoteGenerate,
                this.contextAmount(execution),
              ),
            },
          });
          hasNextStep = true;
        } else {
          processing.statusChanges.push(
            await this.recordSagaStatusTransition(
              osId,
              StatusOrdemServico.Finalizada,
              usuarioId,
            ),
          );
          await this.appendSagaCommand({
            sagaId: execution.id,
            step: {
              sequence: step.sequence + 1,
              destination: 'BILLING',
              command: this.createChainedCommand(
                result,
                SagaCommandType.BillingPaymentOpen,
                this.contextAmount(execution),
              ),
            },
          });
          hasNextStep = true;
        }
        break;
      case SagaCommandType.BillingQuoteGenerate: {
        const statusChange = await this.recordSagaStatusTransition(
          osId,
          StatusOrdemServico.AguardandoAprovacao,
          usuarioId,
        );
        const os = await this.loadOs(osId, {
          itensServico: true,
          itensPeca: true,
        });
        os.valorTotal = this.contextAmount(execution);
        await this.saveOs(os);
        processing.statusChanges.push(statusChange);
        processing.domainEvents.push('ORCAMENTO_GERADO');
        break;
      }
      case SagaCommandType.BillingQuoteApprove: {
        const os = await this.loadOs(osId, { itensPeca: true });
        const first = os.avancarStatus(StatusOrdemServico.Aprovada);
        await this.syncPecaDisponibilidadeAposAprovacao(os);
        const target = os.todasPecasDisponiveis()
          ? StatusOrdemServico.AguardandoServico
          : StatusOrdemServico.AguardandoPecasInsumos;
        const second = os.avancarStatus(target);
        if (target === StatusOrdemServico.AguardandoServico) {
          os.observacao = mergeObservacaoAvisoCompra(os.observacao, false);
        }
        await this.saveOs(os);
        await this.saveSagaHistory(osId, first.anterior, first.novo, usuarioId);
        await this.saveSagaHistory(
          osId,
          second.anterior,
          second.novo,
          usuarioId,
        );
        processing.statusChanges.push(
          {
            osId,
            statusAnterior: first.anterior,
            statusNovo: first.novo,
            usuarioId,
          },
          {
            osId,
            statusAnterior: second.anterior,
            statusNovo: second.novo,
            usuarioId,
          },
        );
        processing.domainEvents.push('ORCAMENTO_APROVADO');
        break;
      }
      case SagaCommandType.BillingQuoteReject: {
        const os = await this.loadOs(osId, { itensPeca: true });
        const { anterior, novo } = os.avancarStatus(
          StatusOrdemServico.Reprovada,
        );
        await this.estornarReservasAoReprovar(os);
        await this.saveOs(os);
        await this.saveSagaHistory(osId, anterior, novo, usuarioId);
        processing.statusChanges.push({
          osId,
          statusAnterior: anterior,
          statusNovo: novo,
          usuarioId,
        });
        processing.domainEvents.push('ORCAMENTO_REPROVADO');
        break;
      }
      case SagaCommandType.BillingPaymentOpen:
        break;
    }

    await manager.save(SagaStepEntity, step);
    execution.status =
      command.type === SagaCommandType.ExecutionReopen
        ? SagaExecutionStatus.Compensada
        : hasNextStep
          ? SagaExecutionStatus.Pendente
          : SagaExecutionStatus.Concluida;
    await manager.save(SagaExecutionEntity, execution);
    return processing;
  }

  private sameSagaResult(
    previous: Record<string, unknown> | null,
    result: SagaResultMessage,
  ): boolean {
    if (!previous) return false;
    const stored = previous as unknown as SagaResultMessage;
    return (
      stored.type === result.type &&
      stored.commandId === result.commandId &&
      stored.sagaId === result.sagaId &&
      stored.osId === result.osId &&
      stored.causationId === result.causationId &&
      stored.correlationId === result.correlationId &&
      stored.outcome === result.outcome &&
      isDeepStrictEqual(stored.payload, result.payload)
    );
  }

  private async recordSagaStatusTransition(
    osId: string,
    next: StatusOrdemServico,
    usuarioId: string | null,
  ): Promise<SagaResultProcessing['statusChanges'][number]> {
    const os = await this.loadOs(osId, { itensServico: true, itensPeca: true });
    const { anterior, novo } = os.avancarStatus(next);
    await this.saveOs(os);
    await this.saveSagaHistory(osId, anterior, novo, usuarioId);
    return { osId, statusAnterior: anterior, statusNovo: novo, usuarioId };
  }

  private async saveSagaHistory(
    osId: string,
    statusAnterior: StatusOrdemServico,
    statusNovo: StatusOrdemServico,
    usuarioId: string | null,
  ): Promise<void> {
    const history = this.manager().create(HistoricoStatusOsEntity, {
      os_id: osId,
      statusAnterior,
      statusNovo,
      usuarioId,
    });
    await this.manager().save(HistoricoStatusOsEntity, history);
  }

  private contextAmount(execution: SagaExecutionEntity): number {
    const amount = Number(execution.context?.valorTotal);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('valorTotal ausente no contexto da Saga');
    }
    return amount;
  }

  private createChainedCommand(
    result: SagaResultMessage,
    type:
      | typeof SagaCommandType.BillingQuoteGenerate
      | typeof SagaCommandType.BillingPaymentOpen,
    valorTotal: number,
  ): SagaCommandMessage {
    return {
      messageId: randomUUID(),
      commandId: randomUUID(),
      sagaId: result.sagaId,
      osId: result.osId,
      occurredAt: new Date().toISOString(),
      correlationId: result.correlationId,
      causationId: result.messageId,
      schemaVersion: 1,
      type,
      payload: { valorTotal },
    };
  }

  private async saveSagaStepAndOutbox(
    sagaId: string,
    step: CreateSagaCommandInput['step'],
  ): Promise<void> {
    const { command, sequence, destination } = step;
    if (command.sagaId !== sagaId) {
      throw new Error('Comando da Saga não corresponde à execução informada.');
    }

    const manager = this.manager();
    const saga = await manager.findOne(SagaExecutionEntity, {
      where: { id: sagaId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!saga) throw new NotFoundError('Execução da Saga não encontrada.');
    const previousStep = await manager.findOne(SagaStepEntity, {
      where: { sagaId },
      order: { sequence: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    const expectedSequence = previousStep ? previousStep.sequence + 1 : 1;
    if (sequence !== expectedSequence) {
      throw new ConflictError(
        `Sequência de etapa inválida; esperada ${expectedSequence}.`,
      );
    }
    const compensationAfterFailure =
      command.type === SagaCommandType.ExecutionReopen &&
      previousStep?.status === 'FALHA' &&
      saga.status === SagaExecutionStatus.Compensando;
    if (
      previousStep &&
      previousStep.status !== 'CONCLUIDA' &&
      !compensationAfterFailure
    ) {
      throw new ConflictError(
        'Não é possível criar a próxima etapa antes de concluir a anterior.',
      );
    }

    const stepEntity = manager.create(SagaStepEntity, {
      commandId: command.commandId,
      sagaId,
      sequence,
      commandType: command.type,
      destination,
      status: 'PENDENTE',
      attemptCount: 0,
      retryable: false,
      lastErrorCode: null,
      lastErrorMessage: null,
      result: null,
      completedAt: null,
    });
    await manager.save(SagaStepEntity, stepEntity);

    const outboxEntity = manager.create(SagaOutboxEntity, {
      messageId: command.messageId,
      commandId: command.commandId,
      destination,
      body: command,
      attemptCount: 0,
      lockedUntil: null,
      publishedAt: null,
    });
    await manager.save(SagaOutboxEntity, outboxEntity);
  }

  async findClienteIdByDocumento(documento: string): Promise<string> {
    return this.clienteTransactional.findIdByDocumento(
      this.manager(),
      documento,
    );
  }

  async findVeiculoIdForCliente(
    placa: string,
    clienteId: string,
  ): Promise<string> {
    return this.veiculoTransactional.findIdForCliente(
      this.manager(),
      placa,
      clienteId,
    );
  }

  async buildItensServico(
    itens: Array<{ servicoId: number }>,
  ): Promise<OsServicoItemDraft[]> {
    const result: OsServicoItemDraft[] = [];
    for (const item of itens) {
      const srv = await this.servicoTransactional.findPreco(
        this.manager(),
        item.servicoId,
      );
      result.push({
        servicoId: srv.servicoId,
        precoAplicado: srv.precoAplicado,
      });
    }
    return result;
  }

  async buildItensPecaWithReserva(
    itens: Array<{ estoqueId: number; quantidade: number }>,
  ): Promise<{
    itens: OsPecaItemDraft[];
    pecaPrecisaObservacaoCompra: boolean;
  }> {
    const result: OsPecaItemDraft[] = [];
    let pecaPrecisaObservacaoCompra = false;
    for (const item of itens) {
      const snap = await this.estoqueTransactional.reservarParaOrdemServico(
        this.manager(),
        item.estoqueId,
        item.quantidade,
      );
      pecaPrecisaObservacaoCompra ||= snap.precisaObservacaoCompra;
      result.push({
        estoqueId: snap.estoqueId,
        quantidade: item.quantidade,
        precoAplicado: snap.precoAplicado,
        disponivelNoDiagnostico: snap.disponivelNoDiagnostico,
      });
    }
    return { itens: result, pecaPrecisaObservacaoCompra };
  }

  async insertNewOs(params: {
    clienteId: string;
    veiculoId: string;
    observacao: string | null;
    itensServico: OsServicoItemDraft[];
    itensPeca: OsPecaItemDraft[];
  }): Promise<OrdemServicoReadModel> {
    const itensServico = params.itensServico.map((item) =>
      this.manager().create(ItemOsServicoEntity, {
        servico_id: item.servicoId,
        precoAplicado: item.precoAplicado,
      }),
    );
    const itensPeca = params.itensPeca.map((item) =>
      this.manager().create(ItemOsEstoqueEntity, {
        estoque_id: item.estoqueId,
        quantidade: item.quantidade,
        precoAplicado: item.precoAplicado,
        disponivelNoDiagnostico: item.disponivelNoDiagnostico,
      }),
    );
    const os = this.manager().create(OrdemServicoTypeormEntity, {
      cliente_id: params.clienteId,
      veiculo_id: params.veiculoId,
      observacao: params.observacao,
      status: StatusOrdemServico.Recebida,
      itensServico,
      itensPeca,
      valorTotal: 0,
    });
    this.refreshValorTotal(this.wrap(os));
    const saved = await this.manager().save(OrdemServicoTypeormEntity, os);
    return this.toReadModel(saved);
  }

  async loadOs(
    osId: string,
    relations: { itensServico?: boolean; itensPeca?: boolean },
  ): Promise<OsWorkflowHandle> {
    const relationList: string[] = [];
    if (relations.itensServico) relationList.push('itensServico');
    if (relations.itensPeca) relationList.push('itensPeca');
    const os = await this.manager().findOne(OrdemServicoTypeormEntity, {
      where: { id: osId },
      relations: relationList,
    });
    if (!os) {
      throw new NotFoundError('Ordem de serviço não encontrada.');
    }
    return this.wrap(os);
  }

  async saveOs(handle: OsWorkflowHandle): Promise<OrdemServicoReadModel> {
    const saved = await this.manager().save(
      OrdemServicoTypeormEntity,
      (handle as OsTypeormHandle).entity,
    );
    return this.toReadModel(saved);
  }

  async estornarReservasPecas(
    itens: Array<{ estoqueId: number; quantidade: number }>,
  ): Promise<void> {
    await this.estoqueTransactional.estornarReservas(this.manager(), itens);
  }

  async softRemoveOsItens(osId: string): Promise<void> {
    const os = await this.loadOs(osId, {
      itensServico: true,
      itensPeca: true,
    });
    const entity = (os as OsTypeormHandle).entity;
    if (entity.itensServico?.length) {
      await this.manager().softRemove(entity.itensServico);
    }
    if (entity.itensPeca?.length) {
      await this.manager().softRemove(entity.itensPeca);
    }
  }

  async replaceItensInDiagnostico(
    osId: string,
    input: EditarItensOsInput,
  ): Promise<void> {
    const current = await this.loadOs(osId, {
      itensServico: true,
      itensPeca: true,
    });
    const entity = (current as OsTypeormHandle).entity;
    await this.estornarReservasPecas(
      (entity.itensPeca ?? []).map((item) => ({
        estoqueId: item.estoque_id,
        quantidade: item.quantidade,
      })),
    );
    if (entity.itensServico?.length) {
      await this.manager().softRemove(entity.itensServico);
    }
    if (entity.itensPeca?.length) {
      await this.manager().softRemove(entity.itensPeca);
    }

    const itensServico = await Promise.all(
      (input.itensServico ?? []).map(async (item) => {
        const built = await this.buildItensServico([
          { servicoId: item.servicoId },
        ]);
        const draft = built[0];
        return this.manager().create(ItemOsServicoEntity, {
          os_id: osId,
          servico_id: draft.servicoId,
          precoAplicado: draft.precoAplicado,
        });
      }),
    );
    const { itens: pecaDrafts, pecaPrecisaObservacaoCompra } =
      await this.buildItensPecaWithReserva(input.itensPeca ?? []);
    const itensPeca = pecaDrafts.map((item) =>
      this.manager().create(ItemOsEstoqueEntity, {
        os_id: osId,
        estoque_id: item.estoqueId,
        quantidade: item.quantidade,
        precoAplicado: item.precoAplicado,
        disponivelNoDiagnostico: item.disponivelNoDiagnostico,
      }),
    );

    entity.itensServico = itensServico;
    entity.itensPeca = itensPeca;
    entity.observacao = mergeObservacaoAvisoCompra(
      entity.observacao,
      pecaPrecisaObservacaoCompra,
    );
    this.refreshValorTotal(this.wrap(entity));
    await this.manager().save(OrdemServicoTypeormEntity, entity);
  }

  refreshValorTotal(handle: OsWorkflowHandle): void {
    handle.valorTotal = handle.calcularValorTotal();
  }

  async syncPecaDisponibilidadeAposAprovacao(
    handle: OsWorkflowHandle,
  ): Promise<void> {
    const entity = (handle as OsTypeormHandle).entity;
    for (const item of entity.itensPeca ?? []) {
      if (item.disponivelNoDiagnostico) continue;
      const cobre = await this.estoqueTransactional.estoqueCobreReservaAtual(
        this.manager(),
        item.estoque_id,
      );
      if (!cobre) continue;
      item.disponivelNoDiagnostico = true;
      await this.manager().save(ItemOsEstoqueEntity, item);
    }
  }

  async darBaixaPecasEmExecucao(handle: OsWorkflowHandle): Promise<void> {
    const entity = (handle as OsTypeormHandle).entity;
    for (const item of entity.itensPeca ?? []) {
      const qBaixa = quantidadeParaBaixaEmExecucao(
        item.disponivelNoDiagnostico,
        item.quantidade,
      );
      await this.estoqueTransactional.darBaixaEmExecucao(
        this.manager(),
        item.estoque_id,
        qBaixa,
      );
    }
  }

  async estornarReservasAoReprovar(handle: OsWorkflowHandle): Promise<void> {
    const entity = (handle as OsTypeormHandle).entity;
    await this.estornarReservasPecas(
      (entity.itensPeca ?? []).map((item) => ({
        estoqueId: item.estoque_id,
        quantidade: item.quantidade,
      })),
    );
  }

  async syncPecasPendentesAposReposicao(
    handle: OsWorkflowHandle,
  ): Promise<void> {
    for (const item of handle.itensPeca) {
      await this.markPecaDisponivelWhenStockAllows(handle, item);
    }
  }

  async loadOsAguardandoPecasForUpdate(
    osId: string,
  ): Promise<OsWorkflowHandle | null> {
    const os = await this.manager().findOne(OrdemServicoTypeormEntity, {
      where: {
        id: osId,
        status: StatusOrdemServico.AguardandoPecasInsumos,
      },
      relations: ['itensPeca'],
    });
    return os ? this.wrap(os) : null;
  }

  private async markPecaDisponivelWhenStockAllows(
    handle: OsWorkflowHandle,
    item: OsPecaItemState,
  ): Promise<void> {
    if (item.disponivelNoDiagnostico) return;
    const entity = (handle as OsTypeormHandle).entity;
    const peca = entity.itensPeca?.find((p) => p.id === item.id);
    if (!peca) return;
    const cobre = await this.estoqueTransactional.estoqueCobreReservaAtual(
      this.manager(),
      item.estoqueId,
    );
    if (!cobre) return;
    peca.disponivelNoDiagnostico = true;
    await this.manager().save(ItemOsEstoqueEntity, peca);
  }
}
