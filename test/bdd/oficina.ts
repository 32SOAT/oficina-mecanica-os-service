import { createHmac, randomInt } from 'node:crypto';
import 'dotenv/config';

const osBase = process.env.OS_BASE_URL ?? 'http://127.0.0.1:3001';
const billingBase = process.env.BILLING_BASE_URL ?? 'http://127.0.0.1:3002';
const execucaoBase = process.env.EXECUCAO_BASE_URL ?? 'http://127.0.0.1:3003';
const sagaToken = process.env.SAGA_TOKEN ?? 'oficina-local';

type Etapa = { etapa: string; status: string };

type Ordem = {
  id: string;
  estoqueId: number;
  documento: string;
  adminToken: string;
  clienteToken: string;
};

let ordemAtual: Ordem | undefined;
let sequencia = 0;

export function ordem(): Ordem {
  if (!ordemAtual) {
    throw new Error('Nenhuma ordem foi preparada neste cenário');
  }
  return ordemAtual;
}

export async function garantirServicos(): Promise<void> {
  const alvos = [osBase, billingBase, execucaoBase];
  for (const base of alvos) {
    const resposta = await fetch(`${base}/api/v1/health`).catch(() => null);
    if (!resposta?.ok) {
      throw new Error(
        `O BDD precisa dos três serviços no ar. ${base} não respondeu em /api/v1/health.`,
      );
    }
  }
}

export async function prepararOrdem(opcoes: {
  quantidadeFisica: number;
  ate: 'recebida' | 'diagnostico' | 'aprovacao' | 'pecas' | 'finalizada';
}): Promise<void> {
  const adminToken = await loginAdmin();
  const documento = cpfUnico();
  const clienteId = await criarCliente(adminToken, documento);
  const placa = await criarVeiculo(adminToken, documento, placaUnica());
  const servicoId = await criarServico(adminToken);
  const estoqueId = await criarEstoque(adminToken, opcoes.quantidadeFisica);
  const id = await criarOrdem(
    adminToken,
    documento,
    placa,
    servicoId,
    estoqueId,
  );
  ordemAtual = {
    id,
    estoqueId,
    documento,
    adminToken,
    clienteToken: assinarCliente(clienteId, documento),
  };

  if (opcoes.ate === 'recebida') return;
  await acaoOs('POST', `${ordemAtual.id}/iniciar-diagnostico`);
  if (opcoes.ate === 'diagnostico') return;
  await acaoOs('POST', `${ordemAtual.id}/gerar-orcamento`);
  if (opcoes.ate === 'aprovacao') return;
  await acaoOs('POST', `${ordemAtual.id}/aprovar-orcamento`, 'cliente');
  if (opcoes.ate === 'pecas') {
    const status = await statusDaOrdem();
    if (status !== 'AGUARDANDO_PECAS_INSUMOS') {
      throw new Error(`A ordem deveria aguardar peça, veio ${status}`);
    }
    return;
  }
  await acaoOs('POST', `${ordemAtual.id}/iniciar-execucao`);
  await acaoOs('POST', `${ordemAtual.id}/finalizar`);
}

export async function acaoOs(
  method: 'POST',
  caminho: string,
  perfil: 'admin' | 'cliente' = 'admin',
): Promise<void> {
  await chamar(method, `${osBase}/api/v1/ordens/${caminho}`, {
    token: perfil === 'admin' ? ordem().adminToken : ordem().clienteToken,
  });
}

export async function tentarOs(
  caminho: string,
): Promise<{ status: number; message: string }> {
  return chamarEsperado(
    'POST',
    `${osBase}/api/v1/ordens/${ordem().id}/${caminho}`,
    { token: ordem().adminToken },
  );
}

export async function statusDaOrdem(): Promise<string> {
  const corpo = await chamar('GET', `${osBase}/api/v1/ordens/${ordem().id}`, {
    token: ordem().adminToken,
  });
  return texto(dados(corpo), 'status');
}

export async function valorTotalDaOrdem(): Promise<number> {
  const corpo = await chamar('GET', `${osBase}/api/v1/ordens/${ordem().id}`, {
    token: ordem().adminToken,
  });
  return numero(dados(corpo), 'valorTotal');
}

export async function reporPeca(quantidade = 1): Promise<void> {
  await chamar(
    'PATCH',
    `${osBase}/api/v1/estoque/${ordem().estoqueId}/operacao`,
    {
      token: ordem().adminToken,
      body: { operacao: 'reposicao', quantidade },
    },
  );
}

export async function confirmarPagamento(): Promise<void> {
  await chamar(
    'POST',
    `${billingBase}/api/v1/pagamentos/${ordem().id}/confirmar`,
    { saga: true },
  );
}

export async function recusarPagamento(): Promise<void> {
  await chamar(
    'POST',
    `${billingBase}/api/v1/pagamentos/${ordem().id}/recusar`,
    { saga: true },
  );
}

export async function statusDoPagamento(): Promise<string> {
  const corpo = await chamar(
    'GET',
    `${billingBase}/api/v1/pagamentos/${ordem().id}`,
    { saga: true },
  );
  return texto(dados(corpo), 'status');
}

export async function statusDoOrcamento(): Promise<string> {
  const corpo = await chamar(
    'GET',
    `${billingBase}/api/v1/orcamentos/${ordem().id}`,
    { saga: true },
  );
  return texto(dados(corpo), 'status');
}

export async function valorTotalDoOrcamento(): Promise<number> {
  const corpo = await chamar(
    'GET',
    `${billingBase}/api/v1/orcamentos/${ordem().id}`,
    { saga: true },
  );
  return numero(dados(corpo), 'valorTotal');
}

export async function etapasDaExecucao(): Promise<Etapa[]> {
  const corpo = await chamar(
    'GET',
    `${execucaoBase}/api/v1/execucoes/${ordem().id}`,
    { saga: true },
  );
  return lista(corpo).flatMap((item) => {
    const etapa = item.etapa;
    const status = item.status;
    if (typeof etapa !== 'string' || typeof status !== 'string') return [];
    return [{ etapa, status }];
  });
}

async function loginAdmin(): Promise<string> {
  const corpo = await chamar('POST', `${osBase}/api/v1/auth/login`, {
    body: {
      email: process.env.BDD_ADMIN_EMAIL ?? 'admin@oficina.com',
      password: process.env.BDD_ADMIN_PASSWORD ?? 'admin123',
    },
  });
  return texto(dados(corpo), 'token');
}

async function criarCliente(token: string, documento: string): Promise<string> {
  sequencia += 1;
  const corpo = await chamar('POST', `${osBase}/api/v1/clientes`, {
    token,
    body: {
      documento,
      nome: `Cliente BDD ${sequencia}`,
      email: `bdd.${sequencia}.${Date.now()}@oficina.test`,
      celularNumero: `+55119${String(80000000 + (sequencia % 10000000))}`,
    },
  });
  return texto(dados(corpo), 'id');
}

async function criarVeiculo(
  token: string,
  documento: string,
  placa: string,
): Promise<string> {
  let atual = placa;
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    try {
      await chamar('POST', `${osBase}/api/v1/veiculos`, {
        token,
        body: {
          placa: atual,
          marca: 'Fiat',
          modelo: 'Uno',
          ano: 2020,
          documentoCliente: documento,
        },
      });
      return atual;
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : '';
      if (!mensagem.includes('409')) throw error;
      atual = placaUnica();
    }
  }
  throw new Error('Não foi possível cadastrar uma placa livre');
}

async function criarServico(token: string): Promise<number> {
  const corpo = await chamar('POST', `${osBase}/api/v1/servicos`, {
    token,
    body: {
      servico: `Mão de obra BDD ${Date.now()}`,
      descricao: 'Troca usada no BDD',
      precoMaoDeObra: 150,
    },
  });
  return numero(dados(corpo), 'id');
}

async function criarEstoque(
  token: string,
  quantidadeFisica: number,
): Promise<number> {
  const corpo = await chamar('POST', `${osBase}/api/v1/estoque`, {
    token,
    body: {
      codigo: `BDD-${Date.now()}-${sequencia}`,
      pecasInsumos: 'Pastilha BDD',
      quantidadeFisica,
      precoUnitario: 80,
    },
  });
  return numero(dados(corpo), 'id');
}

async function criarOrdem(
  token: string,
  documento: string,
  placa: string,
  servicoId: number,
  estoqueId: number,
): Promise<string> {
  const corpo = await chamar('POST', `${osBase}/api/v1/ordens`, {
    token,
    body: {
      documentoCliente: documento,
      placa,
      itensServico: [{ servicoId }],
      itensPeca: [{ estoqueId, quantidade: 1 }],
    },
  });
  return texto(dados(corpo), 'id');
}

function assinarCliente(sub: string, cpf: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET ausente no ambiente da OS');
  }
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const agora = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      sub,
      role: 'cliente',
      cpf,
      iat: agora,
      exp: agora + 3600,
    }),
  );
  const conteudo = `${header}.${payload}`;
  const assinatura = createHmac('sha256', secret)
    .update(conteudo)
    .digest('base64url');
  return `${conteudo}.${assinatura}`;
}

type Chamada = {
  token?: string;
  saga?: boolean;
  body?: unknown;
};

async function chamar(
  method: string,
  url: string,
  opcoes: Chamada = {},
): Promise<unknown> {
  const resposta = await executar(method, url, opcoes);
  if (!resposta.ok) {
    throw new Error(
      `${method} ${url} respondeu ${resposta.status}: ${resposta.message}`,
    );
  }
  return resposta.body;
}

async function chamarEsperado(
  method: string,
  url: string,
  opcoes: Chamada,
): Promise<{ status: number; message: string }> {
  const resposta = await executar(method, url, opcoes);
  return { status: resposta.status, message: resposta.message };
}

async function executar(
  method: string,
  url: string,
  opcoes: Chamada,
): Promise<{ ok: boolean; status: number; message: string; body: unknown }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opcoes.token) headers.authorization = `Bearer ${opcoes.token}`;
  if (opcoes.saga) headers['x-saga-token'] = sagaToken;

  const resposta = await fetch(url, {
    method,
    headers,
    body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body),
  });
  const textoBruto = await resposta.text();
  const body: unknown = textoBruto
    ? (JSON.parse(textoBruto) as unknown)
    : undefined;
  return {
    ok: resposta.ok,
    status: resposta.status,
    message: mensagem(body),
    body,
  };
}

function dados(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new Error('Resposta sem o envelope data');
  }
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Resposta sem objeto em data');
  }
  return data as Record<string, unknown>;
}

function lista(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object' || !('data' in body)) return [];
  const data = body.data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
}

function texto(origem: Record<string, unknown>, campo: string): string {
  const valor = origem[campo];
  if (typeof valor !== 'string' || valor.length === 0) {
    throw new Error(`Campo ${campo} ausente na resposta`);
  }
  return valor;
}

function numero(origem: Record<string, unknown>, campo: string): number {
  const valor = origem[campo];
  const convertido = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isFinite(convertido)) {
    throw new Error(`Campo ${campo} não é numérico`);
  }
  return convertido;
}

function mensagem(body: unknown): string {
  if (!body || typeof body !== 'object' || !('message' in body)) return '';
  const message = body.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.filter((item) => typeof item === 'string').join(' ');
  }
  return '';
}

function base64url(valor: string): string {
  return Buffer.from(valor).toString('base64url');
}

function cpfUnico(): string {
  sequencia += 1;
  let base = String((Date.now() + sequencia) % 1_000_000_000).padStart(9, '0');
  if (/^(\d)\1+$/.test(base)) base = '123456789';
  const primeiro = digitoCpf(base, 10);
  const segundo = digitoCpf(`${base}${primeiro}`, 11);
  return `${base}${primeiro}${segundo}`;
}

function digitoCpf(digits: string, factor: number): number {
  const soma = digits
    .split('')
    .map((digit) => Number(digit))
    .reduce((total, digit) => total + digit * factor--, 0);
  return soma % 11 < 2 ? 0 : 11 - (soma % 11);
}

function placaUnica(): string {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letra = () => letras[randomInt(letras.length)];
  const numeros = String(randomInt(10000)).padStart(4, '0');
  return `${letra()}${letra()}${letra()}${numeros}`;
}
