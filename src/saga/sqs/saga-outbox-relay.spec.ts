import { SagaCommandMessage, SagaCommandType } from '../contracts/saga-message';
import { SagaOutboxRelay } from './saga-outbox-relay';

describe('SagaOutboxRelay', () => {
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

  const makeRelay = (send: jest.Mock) => {
    const manager = { query: jest.fn() };
    const dataSource = {
      transaction: jest.fn((work: (manager: unknown) => Promise<unknown>) =>
        work(manager),
      ),
      query: jest.fn(),
    };
    const publisher = { publish: send };
    const config = {
      getOrThrow: jest.fn().mockReturnValue({ batchSize: 10, leaseMs: 30_000 }),
    };
    return {
      manager,
      dataSource,
      relay: new SagaOutboxRelay(
        dataSource as never,
        publisher as never,
        config as never,
      ),
    };
  };

  it('marks an outbox row published only after SQS confirms the send', async () => {
    const { manager, dataSource, relay } = makeRelay(
      jest.fn().mockResolvedValue(undefined),
    );
    manager.query.mockResolvedValueOnce([
      {
        message_id: command.messageId,
        command_id: command.commandId,
        destination: 'BILLING',
        body: command,
        attempt_count: 1,
      },
    ]);
    dataSource.query.mockResolvedValue([{ message_id: command.messageId }]);

    await relay.publishPendingBatch();

    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = dataSource.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('published_at = NOW()');
    expect(parameters).toEqual([command.messageId]);
  });

  it('normalizes TypeORM UPDATE results before publishing claimed rows', async () => {
    const { manager, dataSource, relay } = makeRelay(
      jest.fn().mockResolvedValue(undefined),
    );
    manager.query.mockResolvedValueOnce([
      [
        {
          message_id: command.messageId,
          command_id: command.commandId,
          destination: 'BILLING',
          body: command,
          attempt_count: 1,
        },
      ],
      1,
    ]);
    dataSource.query.mockResolvedValue([
      [{ message_id: command.messageId }],
      1,
    ]);

    await relay.publishPendingBatch();

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = dataSource.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('published_at = NOW()');
    expect(parameters).toEqual([command.messageId]);
  });

  it('releases the lease with backoff when SQS send fails', async () => {
    const { manager, dataSource, relay } = makeRelay(
      jest.fn().mockRejectedValue(new Error('SQS unavailable')),
    );
    manager.query.mockResolvedValueOnce([
      {
        message_id: command.messageId,
        command_id: command.commandId,
        destination: 'BILLING',
        body: command,
        attempt_count: 2,
      },
    ]);
    dataSource.query.mockResolvedValue([{ message_id: command.messageId }]);

    await relay.publishPendingBatch();

    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = dataSource.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('locked_until = NULL');
    expect(parameters).toEqual([command.messageId, 2_000]);
  });
});
