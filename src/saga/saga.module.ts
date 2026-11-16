import { Module } from '@nestjs/common';
import { SagaClient } from './saga.client';
import { SqsClientModule } from './sqs/sqs-client.module';
import { SqsCommandPublisher } from './sqs/sqs-command-publisher';
import { SagaOutboxRelay } from './sqs/saga-outbox-relay';
import { SagaResultsConsumer } from './sqs/saga-results-consumer';
import { SagaResultProcessor } from './saga-result.processor';
import { OrdemServicoInfraModule } from '../ordens-de-servico/infrastructure/infra.module';
import { SagaQueryService } from './saga-query.service';

@Module({
  imports: [SqsClientModule, OrdemServicoInfraModule],
  providers: [
    SagaClient,
    SagaQueryService,
    SagaResultProcessor,
    SagaResultsConsumer,
    SqsCommandPublisher,
    SagaOutboxRelay,
  ],
  exports: [SagaClient, SagaQueryService],
})
export class SagaModule {}
