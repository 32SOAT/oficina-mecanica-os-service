import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StatusOrdemServico } from '../ordens-de-servico/domain/status-ordem-servico.enum';
import {
  ORDEM_SERVICO_TRANSACTION_PORT,
  OrdemServicoTransactionPort,
  SagaCommandDestination,
  SagaCommandStepInput,
  SagaExecutionInput,
} from '../ordens-de-servico/application/ports/ordem-servico-transaction.port';
import { SagaCommandMessage, SagaCommandType } from './contracts/saga-message';

export type SagaAcceptedResponse = {
  osId: string;
  sagaId: string;
  commandId: string;
  status: 'PENDENTE';
};

export type PagamentoLocal = {
  osId: string;
  valorTotal: number;
  status: 'PENDENTE' | 'APROVADO' | 'RECUSADO';
};

@Injectable()
export class SagaClient {
  private readonly billing =
    process.env.BILLING_BASE_URL ?? 'http://localhost:3002';
  private readonly token = process.env.SAGA_TOKEN ?? 'oficina-local';

  constructor(
    @Inject(ORDEM_SERVICO_TRANSACTION_PORT)
    private readonly transaction: OrdemServicoTransactionPort,
  ) {}

  abrirDiagnostico(
    osId: string,
    requestedBy: string,
  ): Promise<SagaAcceptedResponse> {
    return this.startCommand({
      osId,
      requestedBy,
      action: 'INICIAR_DIAGNOSTICO',
      expectedNextStatus: StatusOrdemServico.EmDiagnostico,
      commandType: SagaCommandType.ExecutionOpen,
      destination: 'EXECUCAO',
      payload: { etapa: 'DIAGNOSTICO' },
    });
  }

  async gerarOrcamento(
    osId: string,
    requestedBy: string,
  ): Promise<SagaAcceptedResponse> {
    return this.transaction.runInTransaction(async (tx) => {
      await tx.lockOsAndEnsureNoActiveSaga(osId);
      const os = await tx.loadOs(osId, { itensServico: true, itensPeca: true });
      os.avancarStatus(StatusOrdemServico.AguardandoAprovacao);
      tx.refreshValorTotal(os);
      const accepted = await this.createCommand(tx, {
        osId,
        requestedBy,
        action: 'GERAR_ORCAMENTO',
        context: { valorTotal: os.valorTotal },
        commandType: SagaCommandType.ExecutionComplete,
        destination: 'EXECUCAO',
        payload: { etapa: 'DIAGNOSTICO' },
      });
      return accepted;
    });
  }

  aprovarOrcamento(
    osId: string,
    requestedBy: string,
  ): Promise<SagaAcceptedResponse> {
    return this.startCommand({
      osId,
      requestedBy,
      action: 'APROVAR_ORCAMENTO',
      expectedNextStatus: StatusOrdemServico.Aprovada,
      commandType: SagaCommandType.BillingQuoteApprove,
      destination: 'BILLING',
      payload: {},
    });
  }

  reprovarOrcamento(
    osId: string,
    requestedBy: string,
  ): Promise<SagaAcceptedResponse> {
    return this.startCommand({
      osId,
      requestedBy,
      action: 'REPROVAR_ORCAMENTO',
      expectedNextStatus: StatusOrdemServico.Reprovada,
      commandType: SagaCommandType.BillingQuoteReject,
      destination: 'BILLING',
      payload: {},
    });
  }

  iniciarReparo(
    osId: string,
    requestedBy: string,
  ): Promise<SagaAcceptedResponse> {
    return this.startCommand({
      osId,
      requestedBy,
      action: 'INICIAR_REPARO',
      expectedNextStatus: StatusOrdemServico.EmExecucao,
      commandType: SagaCommandType.ExecutionOpen,
      destination: 'EXECUCAO',
      payload: { etapa: 'REPARO' },
    });
  }

  async finalizar(
    osId: string,
    requestedBy: string,
  ): Promise<SagaAcceptedResponse> {
    return this.transaction.runInTransaction(async (tx) => {
      await tx.lockOsAndEnsureNoActiveSaga(osId);
      const os = await tx.loadOs(osId, { itensServico: true, itensPeca: true });
      os.avancarStatus(StatusOrdemServico.Finalizada);
      return this.createCommand(tx, {
        osId,
        requestedBy,
        action: 'FINALIZAR',
        context: { valorTotal: os.valorTotal },
        commandType: SagaCommandType.ExecutionComplete,
        destination: 'EXECUCAO',
        payload: { etapa: 'REPARO' },
      });
    });
  }

  exigirPagamentoAprovado(osId: string): Promise<void> {
    return this.get<PagamentoLocal>(
      `${this.billing}/api/v1/pagamentos/${osId}`,
    ).then((pagamento) => {
      if (pagamento.status !== 'APROVADO') {
        throw new BadRequestException(
          'O veículo só sai da oficina depois do pagamento confirmado',
        );
      }
    });
  }

  private startCommand(input: {
    osId: string;
    requestedBy: string;
    action: string;
    expectedNextStatus: StatusOrdemServico;
    commandType: SagaCommandType;
    destination: SagaCommandDestination;
    payload: SagaCommandMessage['payload'];
  }): Promise<SagaAcceptedResponse> {
    return this.transaction.runInTransaction(async (tx) => {
      await tx.lockOsAndEnsureNoActiveSaga(input.osId);
      const os = await tx.loadOs(input.osId, {
        itensServico: true,
        itensPeca: true,
      });
      try {
        os.avancarStatus(input.expectedNextStatus);
      } catch (error) {
        throw error instanceof Error ? error : new BadRequestException();
      }
      return this.createCommand(tx, input);
    });
  }

  private async createCommand(
    tx: Parameters<
      Parameters<OrdemServicoTransactionPort['runInTransaction']>[0]
    >[0],
    input: {
      osId: string;
      requestedBy: string;
      action: string;
      commandType: SagaCommandType;
      destination: SagaCommandDestination;
      payload: SagaCommandMessage['payload'];
      context?: Record<string, unknown>;
    },
  ): Promise<SagaAcceptedResponse> {
    const sagaId = randomUUID();
    const commandId = randomUUID();
    const command: SagaCommandMessage = {
      messageId: randomUUID(),
      commandId,
      sagaId,
      osId: input.osId,
      occurredAt: new Date().toISOString(),
      correlationId: sagaId,
      causationId: null,
      schemaVersion: 1,
      type: input.commandType,
      payload: input.payload,
    } as SagaCommandMessage;
    const execution: SagaExecutionInput = {
      id: sagaId,
      osId: input.osId,
      action: input.action,
      requestedBy: input.requestedBy,
      ...(input.context ? { context: input.context } : {}),
    };
    const step: SagaCommandStepInput = {
      command,
      sequence: 1,
      destination: input.destination,
    };
    await tx.createSagaCommand({ execution, step });
    return { osId: input.osId, sagaId, commandId, status: 'PENDENTE' };
  }

  private async get<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'x-saga-token': this.token },
      });
    } catch {
      throw new BadGatewayException(`Serviço indisponível em ${url}`);
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `Falha ao chamar ${url}: ${response.status}`,
      );
    }
    const text = await response.text();
    if (!text) return undefined as T;
    const parsed = JSON.parse(text) as { data?: unknown };
    return (parsed.data ?? parsed) as T;
  }
}
