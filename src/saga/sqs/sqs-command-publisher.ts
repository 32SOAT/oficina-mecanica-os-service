import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ConfigType } from '../../config/config.module';
import { SagaCommandMessage } from '../contracts/saga-message';
import { SagaCommandDestination } from '../../ordens-de-servico/application/ports/ordem-servico-transaction.port';
import { SQS_CLIENT } from './sqs-client.module';

@Injectable()
export class SqsCommandPublisher {
  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    private readonly config: ConfigService<ConfigType>,
  ) {}

  async publish(
    message: SagaCommandMessage,
    destination: SagaCommandDestination,
  ): Promise<void> {
    const sqs = this.config.getOrThrow('sqs', { infer: true });
    const queueUrl =
      destination === 'BILLING'
        ? sqs.billingCommandQueueUrl
        : sqs.executionCommandQueueUrl;

    if (!queueUrl) {
      const key =
        destination === 'BILLING'
          ? 'SQS_BILLING_COMMAND_QUEUE_URL'
          : 'SQS_EXECUTION_COMMAND_QUEUE_URL';
      throw new Error(`${key} não configurada`);
    }

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: message.osId,
        MessageDeduplicationId: message.commandId,
      }),
    );
  }
}
