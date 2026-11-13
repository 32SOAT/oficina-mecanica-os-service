import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigType } from '../../config/config.module';
import {
  isSagaResultMessage,
  SagaResultMessage,
} from '../contracts/saga-message';
import { SagaResultProcessor } from '../saga-result.processor';
import { SQS_CLIENT } from './sqs-client.module';

@Injectable()
export class SagaResultsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaResultsConsumer.name);
  private running = false;
  private abortController?: AbortController;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    private readonly processor: SagaResultProcessor,
    private readonly config: ConfigService<ConfigType>,
  ) {}

  onModuleInit(): void {
    const sqs = this.config.getOrThrow('sqs', { infer: true });
    if (!sqs.resultsConsumerEnabled) return;
    if (!sqs.resultsQueueUrl) {
      throw new Error(
        'SQS_RESULTS_QUEUE_URL é obrigatória com consumidor ativo',
      );
    }
    this.running = true;
    this.abortController = new AbortController();
    void this.consume(sqs.resultsQueueUrl);
  }

  onModuleDestroy(): void {
    this.running = false;
    this.abortController?.abort();
    this.client.destroy();
  }

  async processMessage(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.Body);
    } catch {
      this.logger.warn(
        `Resultado SQS inválido; aguardando DLQ. messageId=${message.MessageId ?? 'desconhecido'}`,
      );
      return;
    }
    if (!isSagaResultMessage(parsed)) {
      this.logger.warn(
        `Envelope de resultado inválido; aguardando DLQ. messageId=${message.MessageId ?? 'desconhecido'}`,
      );
      return;
    }

    const result: SagaResultMessage = parsed;
    await this.processor.process(result);
    const sqs = this.config.getOrThrow('sqs', { infer: true });
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: sqs.resultsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async consume(queueUrl: string): Promise<void> {
    while (this.running) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 60,
          }),
          { abortSignal: this.abortController?.signal },
        );
        for (const message of response.Messages ?? []) {
          try {
            await this.processMessage(message);
          } catch {
            this.logger.warn(
              `Falha ao processar resultado SQS; mensagem será repetida. messageId=${message.MessageId ?? 'desconhecido'}`,
            );
          }
        }
      } catch {
        if (!this.running) return;
        this.logger.error('Falha na leitura da fila SQS de resultados');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
