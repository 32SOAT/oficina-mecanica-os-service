import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { SagaResultProcessor } from '../saga-result.processor';
import { SagaResultsConsumer } from './saga-results-consumer';
import { SagaResultMessage } from '../contracts/saga-message';
import { ConfigType } from '../../config/config.module';

describe('SagaResultsConsumer', () => {
  const result: SagaResultMessage = {
    messageId: '7d9f9748-b2d2-46ab-8106-fd5dad738b19',
    commandId: 'a707820e-fbe3-483a-b5ae-3a69a3eb947c',
    sagaId: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
    osId: '9abeb153-d57f-4a92-b32a-918fc9e4abc0',
    occurredAt: '2026-11-07T12:00:00.000Z',
    correlationId: 'request-1',
    causationId: 'd1bfe9c4-d8cb-4c93-b9bc-18156d3d9141',
    schemaVersion: 1,
    type: 'SAGA_STEP_RESULT',
    outcome: 'CONCLUIDA',
    payload: {},
  };

  let client: {
    send: jest.Mock<Promise<unknown>, [command: unknown, options?: unknown]>;
    destroy: jest.Mock;
  };
  let processor: { process: jest.Mock };
  let consumer: SagaResultsConsumer;
  const config = {
    getOrThrow: jest.fn(() => ({
      resultsConsumerEnabled: true,
      resultsQueueUrl: 'http://localhost:4566/000000000000/os-results.fifo',
    })),
  };

  beforeEach(() => {
    client = { send: jest.fn().mockResolvedValue({}), destroy: jest.fn() };
    processor = { process: jest.fn().mockResolvedValue({ duplicate: false }) };
    consumer = new SagaResultsConsumer(
      client as unknown as SQSClient,
      processor as unknown as SagaResultProcessor,
      config as unknown as ConfigService<ConfigType>,
    );
  });

  const message = (body: string): Message => ({
    Body: body,
    ReceiptHandle: 'receipt-1',
    MessageId: 'sqs-message-1',
  });

  it('commits a valid result before deleting its SQS message', async () => {
    await consumer.processMessage(message(JSON.stringify(result)));

    expect(processor.process).toHaveBeenCalledWith(result);
    const deleted = client.send.mock.calls.some(
      ([command]) => command instanceof DeleteMessageCommand,
    );
    expect(deleted).toBe(true);
  });

  it('leaves invalid envelopes unacknowledged for the configured DLQ', async () => {
    await consumer.processMessage(message('{"schemaVersion":99}'));

    expect(processor.process).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('does not acknowledge a result when database processing fails', async () => {
    processor.process.mockRejectedValue(new Error('database unavailable'));

    await expect(
      consumer.processMessage(message(JSON.stringify(result))),
    ).rejects.toThrow('database unavailable');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('long-polls the configured results queue when enabled', async () => {
    client.send.mockImplementation((command: unknown) =>
      command instanceof ReceiveMessageCommand
        ? new Promise((resolve) =>
            setTimeout(() => resolve({ Messages: [] }), 10),
          )
        : Promise.resolve({}),
    );
    consumer.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    consumer.onModuleDestroy();

    const receive = client.send.mock.calls
      .map(([command]) => command)
      .find(
        (command): command is ReceiveMessageCommand =>
          command instanceof ReceiveMessageCommand,
      );
    expect(receive).toBeDefined();
    if (!receive) throw new Error('ReceiveMessageCommand was not sent');
    expect(receive.input).toMatchObject({
      QueueUrl: 'http://localhost:4566/000000000000/os-results.fifo',
      WaitTimeSeconds: 20,
      VisibilityTimeout: 60,
    });
  });
});
