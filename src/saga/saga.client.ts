import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';

export type PagamentoLocal = {
  osId: string;
  valorTotal: number;
  status: 'PENDENTE' | 'APROVADO' | 'RECUSADO';
};

@Injectable()
export class SagaClient {
  private readonly billing =
    process.env.BILLING_BASE_URL ?? 'http://localhost:3002';
  private readonly execucao =
    process.env.EXECUCAO_BASE_URL ?? 'http://localhost:3003';
  private readonly token = process.env.SAGA_TOKEN ?? 'oficina-local';

  abrirDiagnostico(osId: string): Promise<void> {
    return this.post(`${this.execucao}/api/v1/execucoes`, {
      osId,
      etapa: 'DIAGNOSTICO',
    });
  }

  concluirDiagnostico(osId: string): Promise<void> {
    return this.post(`${this.execucao}/api/v1/execucoes/${osId}/concluir`, {
      etapa: 'DIAGNOSTICO',
    });
  }

  gerarOrcamento(osId: string, valorTotal: number): Promise<void> {
    return this.post(`${this.billing}/api/v1/orcamentos`, { osId, valorTotal });
  }

  aprovarOrcamento(osId: string): Promise<void> {
    return this.post(`${this.billing}/api/v1/orcamentos/${osId}/aprovar`, {});
  }

  reprovarOrcamento(osId: string): Promise<void> {
    return this.post(`${this.billing}/api/v1/orcamentos/${osId}/reprovar`, {});
  }

  iniciarReparo(osId: string): Promise<void> {
    return this.post(`${this.execucao}/api/v1/execucoes`, {
      osId,
      etapa: 'REPARO',
    });
  }

  concluirReparo(osId: string): Promise<void> {
    return this.post(`${this.execucao}/api/v1/execucoes/${osId}/concluir`, {
      etapa: 'REPARO',
    });
  }

  abrirPagamento(osId: string, valorTotal: number): Promise<void> {
    return this.post(`${this.billing}/api/v1/pagamentos`, { osId, valorTotal });
  }

  async exigirPagamentoAprovado(osId: string): Promise<void> {
    const pagamento = await this.get<PagamentoLocal>(
      `${this.billing}/api/v1/pagamentos/${osId}`,
    );
    if (pagamento.status !== 'APROVADO') {
      throw new BadRequestException(
        'O veículo só sai da oficina depois do pagamento confirmado',
      );
    }
  }

  private async post(url: string, body: unknown): Promise<void> {
    await this.request(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async get<T>(url: string): Promise<T> {
    const payload = await this.request(url, { method: 'GET' });
    return payload as T;
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-saga-token': this.token,
        },
      });
    } catch {
      throw new BadGatewayException(`Serviço indisponível em ${url}`);
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `Falha ao chamar ${url}: ${response.status}`,
      );
    }

    const text = await response.text();
    if (!text) return undefined;
    const parsed = JSON.parse(text) as { data?: unknown };
    return parsed.data ?? parsed;
  }
}
