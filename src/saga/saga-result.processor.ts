import { Inject, Injectable } from '@nestjs/common';
import {
  ORDEM_SERVICO_EVENTS_PORT,
  OrdemServicoEventsPort,
} from '../ordens-de-servico/application/ports/ordem-servico-events.port';
import {
  ORDEM_SERVICO_TRANSACTION_PORT,
  OrdemServicoTransactionPort,
} from '../ordens-de-servico/application/ports/ordem-servico-transaction.port';
import { SagaResultMessage } from './contracts/saga-message';

@Injectable()
export class SagaResultProcessor {
  constructor(
    @Inject(ORDEM_SERVICO_TRANSACTION_PORT)
    private readonly transaction: OrdemServicoTransactionPort,
    @Inject(ORDEM_SERVICO_EVENTS_PORT)
    private readonly events: OrdemServicoEventsPort,
  ) {}

  async process(result: SagaResultMessage): Promise<{ duplicate: boolean }> {
    const processed = await this.transaction.processSagaResult(result);
    if (processed.duplicate) return { duplicate: true };

    for (const change of processed.statusChanges) {
      this.events.emitStatusNotificacao(
        change.osId,
        change.statusAnterior,
        change.statusNovo,
        change.usuarioId,
      );
    }
    for (const event of processed.domainEvents) {
      switch (event) {
        case 'ORCAMENTO_GERADO':
          this.events.emitOrcamentoGerado(result.osId);
          break;
        case 'ORCAMENTO_APROVADO':
          this.events.emitOrcamentoAprovado(result.osId);
          break;
        case 'ORCAMENTO_REPROVADO':
          this.events.emitOrcamentoReprovado(result.osId);
          break;
        case 'EXECUCAO_INICIADA':
          this.events.emitOsEmExecucao(result.osId);
          break;
      }
    }
    return { duplicate: false };
  }
}
