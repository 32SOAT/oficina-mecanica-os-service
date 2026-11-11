# OS Service

Dono da ficha da ordem de serviço. Aqui ficam o status canônico, o histórico, o cliente, o veículo, o usuário, a autenticação de administrador, o catálogo de mão de obra, o estoque e o e-mail. Esta API também conduz o fluxo: persiste a Saga, envia comandos ao billing e à execução por SQS e aplica o resultado ao status local.

A decisão completa está em [docs/adr/001-divisao-dos-servicos-e-banco-por-aplicacao.md](docs/adr/001-divisao-dos-servicos-e-banco-por-aplicacao.md). O desenho do fluxo, com status e chamadas entre os serviços, está em [docs/fluxo-da-ordem.md](docs/fluxo-da-ordem.md).

O [guia de operação da Saga SQS](docs/operacao-saga-sqs.md) descreve rollout, flags, inspeção de outbox/filas/DLQs, reconciliação e recuperação de falhas.

Para configurar o ambiente local e percorrer uma ordem de ponta a ponta, siga [Rodar e testar a OS localmente](docs/rodar-e-testar-os-localmente.md).

## O que fica aqui

- Cadastro de cliente, veículo, usuário e login de administrador.
- Catálogo de mão de obra (`servico`: nome, descrição e preço). Esse preço entra no `valorTotal` da ordem, na mesma transação das peças.
- Estoque: reserva na abertura, espera em `AGUARDANDO_PECAS_INSUMOS` e baixa ao iniciar a execução.
- Status, histórico e notificações.
- Orquestração assíncrona do billing e da execução por filas SQS FIFO, com outbox e consumidor de resultados.

## O que não fica aqui

- A execução não guarda o catálogo. Ela só registra se o diagnóstico ou o reparo está aberto ou concluído.
- O billing não recalcula preço. Ele recebe o `valorTotal` já fechado e controla orçamento e pagamento.
- O Mercado Pago fica no billing. A OS só entrega depois de consultar o pagamento e encontrá-lo `APROVADO`.

## Banco

Postgres `oficina_os` no próprio repositório, porta **5435** no host. A 5432 continua com o banco do monólito. O schema nasce com `npm run migration:run`. Este serviço não conecta no banco do billing nem no da execução.

## Mensageria da Saga

O provisionamento cria três filas FIFO (`billing-commands`, `execution-commands` e `os-results`), cada uma com DLQ FIFO, redrive após cinco recebimentos e criptografia SSE-SQS. A OS grava execução, etapa e outbox na mesma transação. O relay publica comandos com `osId` como grupo FIFO e `commandId` como deduplicação; além da ordem FIFO, a OS valida no banco a sequência de cada etapa e só cria a próxima após sucesso da anterior. O consumidor de resultados valida correlação, persiste a resposta e só então confirma a mensagem. O status canônico e o histórico avançam na mesma transação da OS somente após o resultado remoto de sucesso. Há consistência eventual: até o resultado ser processado, o status de negócio permanece no estado anterior.

As rotas de ação remota mantêm os caminhos existentes e respondem `202 Accepted`. O corpo tem `osId`, `sagaId`, `commandId` e `status: "PENDENTE"`; o status da ordem continua no estado anterior até a conclusão remota. A OS serializa novas ações com lock por ordem: se já houver Saga `PENDENTE` ou `EM_PROCESSAMENTO`, a nova ação recebe `409 Conflict` e não cria execução, etapa ou outbox. Depois de uma Saga terminal, a próxima ação ainda precisa ser válida para o status canônico atual. Consulte o andamento com `GET /api/v1/ordens/:id/sagas/:sagaId`, que retorna a Saga e suas etapas ordenadas para polling. Uma etapa com falha não avança o status canônico. A ação de entrega continua síncrona: a OS consulta o pagamento no Billing e só grava `ENTREGUE` quando a resposta é `APROVADO`.

Para desenvolvimento local, crie o `.env` conforme `.env.example` e inicie Postgres e Floci:

```bash
cp .env.example .env
docker compose up -d db floci
```

O init script cria as filas FIFO e DLQs no Floci. A imagem `floci/floci:latest-compat` inclui AWS CLI para executar esse script. Billing e Execução usam o endpoint `http://localhost:4566` e as URLs em seus próprios `.env.example`. Floci não exige conta ou token. Para apps dentro de containers, configure `FLOCI_HOSTNAME=floci` para que as URLs devolvidas pelo SQS usem um host acessível entre containers. A operação em AWS e a ordem de ativação estão no runbook.

Para provisionar na AWS, informe os nomes das roles existentes dos três serviços e aplique o módulo:

```bash
cd infra/sqs
terraform init
terraform plan \
  -var='os_role_name=ROLE_OS' \
  -var='billing_role_name=ROLE_BILLING' \
  -var='execution_role_name=ROLE_EXECUCAO'
terraform apply \
  -var='os_role_name=ROLE_OS' \
  -var='billing_role_name=ROLE_BILLING' \
  -var='execution_role_name=ROLE_EXECUCAO'
```

Configure os outputs `*_queue_url` nos serviços e `SQS_REGION` para a região escolhida. Em AWS, deixe `SQS_ENDPOINT_URL` vazio/ausente e use credenciais temporárias da role do serviço, sem colocar chaves AWS no `.env`.

## Execução local

Suba os três bancos e os três serviços. Billing e execução precisam estar no ar antes de percorrer uma ordem.

```bash
docker compose up -d
copy .env.example .env
npm install
npm run migration:run
npm run start:dev
```

- API: http://localhost:3001/api
- Health: http://localhost:3001/api/v1/health

As rotas de ação continuam com os mesmos caminhos, mas ações que dependem de Billing ou Execução agora são assíncronas e respondem `202 Accepted`. Faça polling na consulta de Saga até a etapa terminar antes de iniciar uma ação dependente:

1. `POST /api/v1/ordens/:id/iniciar-diagnostico` abre o diagnóstico na Execução; a OS muda para `EM_DIAGNOSTICO` depois do resultado.
2. `POST /api/v1/ordens/:id/gerar-orcamento` conclui o diagnóstico e, após sucesso, cria o orçamento no Billing.
3. `POST /api/v1/ordens/:id/aprovar-orcamento` ou `reprovar-orcamento` atualiza o Billing; a OS aplica estoque e status somente após sucesso.
4. `POST /api/v1/ordens/:id/iniciar-execucao` abre o reparo; a baixa de estoque e o status acontecem após o resultado.
5. `POST /api/v1/ordens/:id/finalizar` conclui o reparo, grava `FINALIZADA` após sucesso e então solicita a abertura local de um pagamento pendente no Billing.
6. Consulte `GET /api/v1/ordens/:id/sagas/:sagaId` usando os identificadores da resposta `202`. Abra `http://localhost:3002/api/v1/pagamentos/:osId/checkout` e pague com o cartão de teste. A order aprovada grava o pagamento como `APROVADO`.
7. `POST /api/v1/ordens/:id/entregar` continua síncrono e só segue se o pagamento estiver aprovado.

O login de administrador continua em `POST /api/v1/auth/login` (`admin@oficina.com` / `admin123` depois das migrations) e serve para abrir, diagnosticar, executar, finalizar e entregar. Aprovar e reprovar o orçamento continuam exigindo JWT com `role: cliente`, `sub` e `cpf`, assinado com o `JWT_SECRET` do `.env`. Sem a Lambda, esse token pode ser gerado na máquina local.

`POST /api/v1/seeding` popula cliente, veículo, serviço, estoque e usuários. A senha dos usuários criados pelo seed é `SeedPassword123!`.
