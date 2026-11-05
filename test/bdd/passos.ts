import { Before, Given, Then, When } from '@cucumber/cucumber';
import {
  acaoOs,
  confirmarPagamento,
  etapasDaExecucao,
  garantirServicos,
  ordem,
  prepararOrdem,
  recusarPagamento,
  reporPeca,
  statusDaOrdem,
  statusDoOrcamento,
  statusDoPagamento,
  tentarOs,
  valorTotalDaOrdem,
  valorTotalDoOrcamento,
} from './oficina';

Before(async function () {
  await garantirServicos();
});

Given('uma ordem recebida com peça em estoque', async function () {
  await prepararOrdem({ quantidadeFisica: 5, ate: 'recebida' });
});

Given('uma ordem finalizada com pagamento pendente', async function () {
  await prepararOrdem({ quantidadeFisica: 5, ate: 'finalizada' });
});

Given('uma ordem em diagnóstico sem peça disponível', async function () {
  await prepararOrdem({ quantidadeFisica: 0, ate: 'diagnostico' });
});

Given('uma ordem aguardando peça', async function () {
  await prepararOrdem({ quantidadeFisica: 0, ate: 'pecas' });
});

Given('uma ordem aguardando aprovação', async function () {
  await prepararOrdem({ quantidadeFisica: 5, ate: 'aprovacao' });
});

When('o administrador inicia o diagnóstico', async function () {
  await acaoOs('POST', `${ordem().id}/iniciar-diagnostico`);
});

When('o administrador gera o orçamento', async function () {
  await acaoOs('POST', `${ordem().id}/gerar-orcamento`);
});

When('o cliente aprova o orçamento', async function () {
  await acaoOs('POST', `${ordem().id}/aprovar-orcamento`, 'cliente');
});

When('o cliente reprova o orçamento', async function () {
  await acaoOs('POST', `${ordem().id}/reprovar-orcamento`, 'cliente');
});

When('o administrador inicia a execução', async function () {
  await acaoOs('POST', `${ordem().id}/iniciar-execucao`);
});

When('o administrador finaliza a ordem', async function () {
  await acaoOs('POST', `${ordem().id}/finalizar`);
});

When('o administrador entrega o veículo', async function () {
  await acaoOs('POST', `${ordem().id}/entregar`);
});

When('o administrador cancela a ordem', async function () {
  await acaoOs('POST', `${ordem().id}/cancelar`);
});

When('o administrador repõe a peça em falta', async function () {
  await reporPeca();
});

When('o pagamento é confirmado', async function () {
  await confirmarPagamento();
});

When('o pagamento é recusado', async function () {
  await recusarPagamento();
});

When('o administrador tenta entregar o veículo', async function () {
  const resposta = await tentarOs('entregar');
  if (resposta.status !== 400) {
    throw new Error(`A entrega deveria ser recusada, veio ${resposta.status}`);
  }
  if (!resposta.message.includes('pagamento confirmado')) {
    throw new Error(`Mensagem inesperada: ${resposta.message}`);
  }
});

When('o administrador tenta iniciar a execução', async function () {
  const resposta = await tentarOs('iniciar-execucao');
  if (resposta.status !== 400) {
    throw new Error(
      `A execução deveria ser recusada, veio ${resposta.status}: ${resposta.message}`,
    );
  }
});

Then('a ordem fica {string}', async function (status: string) {
  await exigirStatus(status);
});

Then('a ordem continua {string}', async function (status: string) {
  await exigirStatus(status);
});

Then(
  'a entrega é recusada e a ordem continua {string}',
  async function (status: string) {
    await exigirStatus(status);
  },
);

Then(
  'a execução é recusada e a ordem continua {string}',
  async function (status: string) {
    await exigirStatus(status);
  },
);

Then('o pagamento no billing fica {string}', async function (status: string) {
  const atual = await statusDoPagamento();
  if (atual !== status) {
    throw new Error(`Pagamento esperado ${status}, veio ${atual}`);
  }
});

Then('o orçamento no billing fica {string}', async function (status: string) {
  const atual = await statusDoOrcamento();
  if (atual !== status) {
    throw new Error(`Orçamento esperado ${status}, veio ${atual}`);
  }
});

Then('o billing guarda o mesmo valor total da ordem', async function () {
  const naOs = await valorTotalDaOrdem();
  const noBilling = await valorTotalDoOrcamento();
  if (naOs !== noBilling) {
    throw new Error(`valorTotal da OS é ${naOs} e o do billing é ${noBilling}`);
  }
});

Then(
  'o diagnóstico e o reparo estão concluídos na execução',
  async function () {
    const etapas = await etapasDaExecucao();
    for (const etapa of ['DIAGNOSTICO', 'REPARO']) {
      const item = etapas.find((atual) => atual.etapa === etapa);
      if (item?.status !== 'CONCLUIDA') {
        throw new Error(
          `${etapa} deveria estar CONCLUIDA, veio ${item?.status ?? 'ausente'}`,
        );
      }
    }
  },
);

async function exigirStatus(status: string): Promise<void> {
  const atual = await statusDaOrdem();
  if (atual !== status) {
    throw new Error(`Status esperado ${status}, veio ${atual}`);
  }
}
