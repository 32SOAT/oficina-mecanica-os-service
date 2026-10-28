import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { SagaClient } from './saga.client';

describe('SagaClient', () => {
  beforeEach(() => {
    process.env.BILLING_BASE_URL = 'http://billing.test';
    process.env.EXECUCAO_BASE_URL = 'http://execucao.test';
    process.env.SAGA_TOKEN = 'oficina-local';
    jest.restoreAllMocks();
  });

  it('opens the diagnosis in the execution service', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve('{"data":{"id":"etapa-1"}}'),
    } as Response);

    await new SagaClient().abrirDiagnostico('os-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://execucao.test/api/v1/execucoes');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-saga-token': 'oficina-local' });
  });

  it('blocks delivery until the payment is approved', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":{"status":"PENDENTE"}}'),
    } as Response);

    await expect(
      new SagaClient().exigirPagamentoAprovado('os-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows delivery when the payment is approved', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":{"status":"APROVADO"}}'),
    } as Response);

    await expect(
      new SagaClient().exigirPagamentoAprovado('os-1'),
    ).resolves.toBeUndefined();
  });

  it('reports when the other service cannot be reached', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(
      new SagaClient().abrirPagamento('os-1', 10),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
