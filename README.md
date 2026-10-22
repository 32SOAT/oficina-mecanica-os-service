# OS Service

Dono da ficha da ordem de serviço. Aqui ficam o status canônico, o histórico, o cliente, o veículo, o usuário, a autenticação de administrador, o catálogo de mão de obra, o estoque e o e-mail. Esta API também conduz o fluxo: grava o status e chama o billing e a execução.

A decisão completa está em [docs/adr/001-divisao-dos-servicos-e-banco-por-aplicacao.md](docs/adr/001-divisao-dos-servicos-e-banco-por-aplicacao.md).

## O que fica aqui

- Cadastro de cliente, veículo, usuário e login de administrador.
- Catálogo de mão de obra (`servico`: nome, descrição e preço). Esse preço entra no `valorTotal` da ordem, na mesma transação das peças.
- Estoque: reserva na abertura, espera em `AGUARDANDO_PECAS_INSUMOS` e baixa ao iniciar a execução.
- Status, histórico e notificações.
- Orquestração das chamadas ao billing (`localhost:3002`) e à execução (`localhost:3003`).

## O que não fica aqui

- A execução não guarda o catálogo. Ela só registra se o diagnóstico ou o reparo está aberto ou concluído.
- O billing não recalcula preço. Ele recebe o `valorTotal` já fechado e controla orçamento e pagamento.
- Mercado Pago ainda não entra. O pagamento local é confirmado no billing antes de `ENTREGUE`.

## Banco

Postgres `oficina_os` no próprio repositório, porta **5435** no host. A 5432 continua com o banco do monólito. O schema nasce com `npm run migration:run`. Este serviço não conecta no banco do billing nem no da execução.

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

As rotas da OS continuam as mesmas do monólito. Em cada transição a OS grava o status e avisa o serviço dono da etapa:

1. `POST /api/v1/ordens/:id/iniciar-diagnostico` abre o diagnóstico na execução.
2. `POST /api/v1/ordens/:id/gerar-orcamento` conclui o diagnóstico e cria o orçamento.
3. `POST /api/v1/ordens/:id/aprovar-orcamento` ou `reprovar-orcamento` atualiza o billing.
4. `POST /api/v1/ordens/:id/iniciar-execucao` abre o reparo.
5. `POST /api/v1/ordens/:id/finalizar` conclui o reparo e abre um pagamento pendente.
6. `POST http://localhost:3002/api/v1/pagamentos/:osId/confirmar` com o header `x-saga-token: oficina-local`.
7. `POST /api/v1/ordens/:id/entregar` só segue se o pagamento estiver aprovado.

O login de administrador continua em `POST /api/v1/auth/login` (`admin@oficina.com` / `admin123` depois das migrations) e serve para abrir, diagnosticar, executar, finalizar e entregar. Aprovar e reprovar o orçamento continuam exigindo JWT com `role: cliente`, `sub` e `cpf`, assinado com o `JWT_SECRET` do `.env`. Sem a Lambda, esse token pode ser gerado na máquina local.

`POST /api/v1/seeding` popula cliente, veículo, serviço, estoque e usuários. A senha dos usuários criados pelo seed é `SeedPassword123!`.
