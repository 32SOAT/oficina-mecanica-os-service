import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { SagaCommandMessage, SagaCommandType } from '../contracts/saga-message';
import { SqsCommandPublisher } from './sqs-command-publisher';

describe('SqsCommandPublisher', () => {
  const command: SagaCommandMessage = {
    messageId: '7d9f9748-b2d2-46ab-8106-fd5dad738b19',
    commandId: 'a707820e-fbe3-483a-b5ae-3a69a3eb947c',
    sagaId: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
    osId: '9abeb153-d57f-4a92-b32a-918fc9e4abc0',
    occurredAt: '2026-11-07T12:00:00.000Z',
    correlationId: 'request-1',
    causationId: null,
    schemaVersion: 1,
    type: SagaCommandType.BillingQuoteGenerate,
    payload: { valorTotal: 125.5 },
  };

  it('sends FIFO commands grouped by OS and deduplicated by command ID', async () => {
    const sqs = { send: jest.fn().mockResolvedValue({ MessageId: 'sqs-1' }) };
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        billingCommandQueueUrl: 'http://sqs.test/billing.fifo',
      }),
    };
    const publisher = new SqsCommandPublisher(sqs as never, config as never);

    await publisher.publish(command, 'BILLING');

    const sent = sqs.send.mock.calls[0][0] as SendMessageCommand;
    expect(sent.input).toMatchObject({
      QueueUrl: 'http://sqs.test/billing.fifo',
      MessageBody: JSON.stringify(command),
      MessageGroupId: command.osId,
      MessageDeduplicationId: command.commandId,
    });
  });

  it('fails clearly when the destination queue is not configured', async () => {
    const publisher = new SqsCommandPublisher(
      { send: jest.fn() } as never,
      { getOrThrow: jest.fn().mockReturnValue({}) } as never,
    );

    await expect(publisher.publish(command, 'EXECUCAO')).rejects.toThrow(
      'SQS_EXECUTION_COMMAND_QUEUE_URL não configurada',
    );
  });
});
