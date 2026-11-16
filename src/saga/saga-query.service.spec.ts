import { NotFoundError } from '../common/application/errors/application.errors';
import { SagaQueryService } from './saga-query.service';

describe('SagaQueryService', () => {
  it('returns only the Saga scoped to the requested order', async () => {
    const saga = { sagaId: 'saga-id', osId: 'os-id', steps: [] };
    const transaction = { findSagaStatus: jest.fn().mockResolvedValue(saga) };
    const service = new SagaQueryService(transaction as never);

    await expect(service.get('os-id', 'saga-id')).resolves.toBe(saga);
    expect(transaction.findSagaStatus).toHaveBeenCalledWith('os-id', 'saga-id');
  });

  it('does not reveal a Saga when it is missing or belongs to another order', async () => {
    const service = new SagaQueryService({
      findSagaStatus: jest.fn().mockResolvedValue(null),
    } as never);

    await expect(service.get('os-id', 'other-saga')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
