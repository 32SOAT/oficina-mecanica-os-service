import { BadRequestException } from '@nestjs/common';
import { SagaClient } from '../src/saga/saga.client';

describe('SagaClient', () => {
  const client = new SagaClient();

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects delivery when payment is still pending', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { osId: '1', valorTotal: 10, status: 'PENDENTE' },
          }),
        ),
    } as Response);

    await expect(client.exigirPagamentoAprovado('1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows delivery when payment is approved', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { osId: '1', valorTotal: 10, status: 'APROVADO' },
          }),
        ),
    } as Response);

    await expect(client.exigirPagamentoAprovado('1')).resolves.toBeUndefined();
  });

  it('reports when the other service is down', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(client.abrirDiagnostico('1')).rejects.toThrow(
      'Serviço indisponível',
    );
  });
});
