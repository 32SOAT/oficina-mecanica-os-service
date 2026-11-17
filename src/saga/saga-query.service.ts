import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/application/errors/application.errors';
import {
  ORDEM_SERVICO_TRANSACTION_PORT,
  OrdemServicoTransactionPort,
  SagaStatusQuery,
} from '../ordens-de-servico/application/ports/ordem-servico-transaction.port';

@Injectable()
export class SagaQueryService {
  constructor(
    @Inject(ORDEM_SERVICO_TRANSACTION_PORT)
    private readonly transaction: OrdemServicoTransactionPort,
  ) {}

  async get(osId: string, sagaId: string): Promise<SagaStatusQuery> {
    const saga = await this.transaction.findSagaStatus(osId, sagaId);
    if (!saga) throw new NotFoundError('Execução da Saga não encontrada.');
    return saga;
  }
}
