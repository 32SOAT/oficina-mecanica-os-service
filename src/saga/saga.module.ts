import { Module } from '@nestjs/common';
import { SagaClient } from './saga.client';

@Module({
  providers: [SagaClient],
  exports: [SagaClient],
})
export class SagaModule {}
