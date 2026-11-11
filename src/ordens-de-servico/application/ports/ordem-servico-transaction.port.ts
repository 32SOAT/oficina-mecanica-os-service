import {
  EditarItensOsInput,
  OrdemServicoReadModel,
} from '../dto/ordem-servico.dto';
import { StatusOrdemServico } from '../../domain/status-ordem-servico.enum';
import {
  SagaCommandMessage,
  SagaResultMessage,
  SagaStepStatus,
} from '../../../saga/contracts/saga-message';

export type SagaCommandDestination = 'BILLING' | 'EXECUCAO';

export type SagaCommandStepInput = {
  command: SagaCommandMessage;
  sequence: number;
  destination: SagaCommandDestination;
};

export type SagaExecutionInput = {
  id: string;
  osId: string;
  action: string;
  requestedBy: string | null;
  context?: Record<string, unknown>;
};

export type CreateSagaCommandInput = {
  execution: SagaExecutionInput;
  step: SagaCommandStepInput;
};

export type AppendSagaCommandInput = {
  sagaId: string;
  step: SagaCommandStepInput;
};

export type SagaResultStatusChange = {
  osId: string;
  statusAnterior: StatusOrdemServico;
  statusNovo: StatusOrdemServico;
  usuarioId: string | null;
};

export type SagaResultDomainEvent =
  | 'ORCAMENTO_GERADO'
  | 'ORCAMENTO_APROVADO'
  | 'ORCAMENTO_REPROVADO'
  | 'EXECUCAO_INICIADA';

export type SagaResultProcessing = {
  duplicate: boolean;
  statusChanges: SagaResultStatusChange[];
  domainEvents: SagaResultDomainEvent[];
};

export type SagaStepQuery = {
  commandId: string;
  sequence: number;
  commandType: string;
  status: SagaStepStatus;
  attemptCount: number;
  retryable: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type SagaStatusQuery = {
  sagaId: string;
  osId: string;
  action: string;
  status: SagaStepStatus;
  createdAt: Date;
  updatedAt: Date;
  steps: SagaStepQuery[];
};

export const ORDEM_SERVICO_TRANSACTION_PORT = 'ORDEM_SERVICO_TRANSACTION_PORT';

export type OsServicoItemDraft = {
  servicoId: number;
  precoAplicado: number;
};

export type OsPecaItemDraft = {
  estoqueId: number;
  quantidade: number;
  precoAplicado: number;
  disponivelNoDiagnostico: boolean;
};

export type OsPecaItemState = {
  id: string;
  estoqueId: number;
  quantidade: number;
  disponivelNoDiagnostico: boolean;
};

export interface OsWorkflowHandle {
  readonly id: string;
  readonly status: StatusOrdemServico;
  observacao: string | null;
  valorTotal: number;
  readonly itensPeca: OsPecaItemState[];
  avancarStatus(para: StatusOrdemServico): {
    anterior: StatusOrdemServico;
    novo: StatusOrdemServico;
  };
  calcularValorTotal(): number;
  todasPecasDisponiveis(): boolean;
}

export interface OrdemServicoTransactionalOperations {
  lockOsAndEnsureNoActiveSaga(osId: string): Promise<void>;
  createSagaCommand(input: CreateSagaCommandInput): Promise<void>;
  appendSagaCommand(input: AppendSagaCommandInput): Promise<void>;
  findClienteIdByDocumento(documento: string): Promise<string>;
  findVeiculoIdForCliente(placa: string, clienteId: string): Promise<string>;
  buildItensServico(
    itens: Array<{ servicoId: number }>,
  ): Promise<OsServicoItemDraft[]>;
  buildItensPecaWithReserva(
    itens: Array<{ estoqueId: number; quantidade: number }>,
  ): Promise<{
    itens: OsPecaItemDraft[];
    pecaPrecisaObservacaoCompra: boolean;
  }>;
  insertNewOs(params: {
    clienteId: string;
    veiculoId: string;
    observacao: string | null;
    itensServico: OsServicoItemDraft[];
    itensPeca: OsPecaItemDraft[];
  }): Promise<OrdemServicoReadModel>;
  loadOs(
    osId: string,
    relations: { itensServico?: boolean; itensPeca?: boolean },
  ): Promise<OsWorkflowHandle>;
  saveOs(handle: OsWorkflowHandle): Promise<OrdemServicoReadModel>;
  estornarReservasPecas(
    itens: Array<{ estoqueId: number; quantidade: number }>,
  ): Promise<void>;
  softRemoveOsItens(osId: string): Promise<void>;
  replaceItensInDiagnostico(
    osId: string,
    input: EditarItensOsInput,
  ): Promise<void>;
  refreshValorTotal(handle: OsWorkflowHandle): void;
  syncPecaDisponibilidadeAposAprovacao(handle: OsWorkflowHandle): Promise<void>;
  darBaixaPecasEmExecucao(handle: OsWorkflowHandle): Promise<void>;
  estornarReservasAoReprovar(handle: OsWorkflowHandle): Promise<void>;
  loadOsAguardandoPecasForUpdate(
    osId: string,
  ): Promise<OsWorkflowHandle | null>;
  syncPecasPendentesAposReposicao(handle: OsWorkflowHandle): Promise<void>;
}

export abstract class OrdemServicoTransactionPort {
  abstract runInTransaction<T>(
    work: (operations: OrdemServicoTransactionalOperations) => Promise<T>,
  ): Promise<T>;
  abstract processSagaResult(
    result: SagaResultMessage,
  ): Promise<SagaResultProcessing>;
  abstract findSagaStatus(
    osId: string,
    sagaId: string,
  ): Promise<SagaStatusQuery | null>;
}
