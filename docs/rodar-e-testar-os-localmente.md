# Rodar e testar a OS localmente

Este guia sobe OS, Billing e Execução no computador local e percorre uma ordem pelo fluxo da Saga SQS. O teste termina com o pagamento local em `PENDENTE`. Aprovar um pagamento no Mercado Pago e entregar o veículo são passos opcionais que exigem credenciais de teste do Mercado Pago.

## Pré-requisitos

- Docker com Compose, Node.js 22 ou superior, npm, `curl` e `jq`.
- Dependências npm instaladas nos três repositórios.
- Portas locais livres: OS `3001`/`5435`, Billing `3002`/`5433`, Execução `3003`/`8000` e Floci `4566`.

Os repositórios ficam lado a lado:

```text
MICROSERVICES/
├── oficina-mecanica-os-service/
├── oficina-mecanica-billing-service/
└── oficina-mecanica-execucao-service/
```

## Preparar configuração e dependências

Em cada repositório, crie o `.env` a partir do exemplo:

```bash
cd oficina-mecanica-os-service
cp .env.example .env

cd ../oficina-mecanica-billing-service
cp .env.example .env
# Edite .env e defina SQS_WORKER_ENABLED=true.

cd ../oficina-mecanica-execucao-service
cp .env.example .env
# Edite .env e defina SQS_WORKER_ENABLED=true.
```

No `.env` da OS, confirme `SQS_OUTBOX_RELAY_ENABLED=true` e `SQS_RESULTS_CONSUMER_ENABLED=true`. Os exemplos já apontam para as filas do Floci em `http://localhost:4566`. No Billing e na Execução, mantenha as URLs de suas respectivas filas e `SQS_ENDPOINT_URL=http://localhost:4566`. O Billing exige `POSTGRES_PASSWORD`; o valor do exemplo serve para desenvolvimento local. Credenciais do Mercado Pago podem ficar vazias se você for testar somente até o pagamento `PENDENTE`.

Suba os recursos locais em terminais separados:

```bash
cd oficina-mecanica-os-service
docker compose up -d db floci
```

```bash
cd oficina-mecanica-billing-service
docker compose up -d db
```

```bash
cd oficina-mecanica-execucao-service
docker compose up -d dynamodb
```

O Floci cria as filas FIFO e DLQs no início. O Billing cria seu schema Postgres ao iniciar; a Execução cria suas tabelas DynamoDB ao iniciar.

Antes de iniciar as aplicações, confira se as seis filas estão presentes:

```bash
cd oficina-mecanica-os-service
docker compose exec floci aws --endpoint-url http://localhost:4566 \
  sqs list-queues --region us-east-1 --output table
```

## Aplicar migrations e iniciar os serviços

Na OS, aplique as migrations:

```bash
cd oficina-mecanica-os-service
npm run migration:run
```

Inicie cada aplicação em um terminal diferente:

```bash
cd oficina-mecanica-os-service
npm run start:dev
```

```bash
cd oficina-mecanica-billing-service
npm run start:dev
```

```bash
cd oficina-mecanica-execucao-service
npm run start:dev
```

Espere as três aplicações iniciarem antes de enviar ações. Confirme os health checks:

```bash
curl -fsS http://localhost:3001/api/v1/health | jq
curl -fsS http://localhost:3002/api/v1/health | jq
curl -fsS http://localhost:3003/api/v1/health | jq
```

## Conferir o OpenAPI local

Abra as interfaces Swagger dos três serviços:

- OS: <http://localhost:3001/api>
- Billing: <http://localhost:3002/api>
- Execução: <http://localhost:3003/api>

Na OS, confirme que as ações remotas documentam `202 Accepted` com `data.sagaId` e `data.commandId`, que `POST /api/v1/ordens/{id}/avancar-status` mostra as respostas `201` e `202`, e que `GET /api/v1/ordens/{id}/sagas/{sagaId}` documenta o estado e as etapas.

No Billing, as antigas rotas HTTP de comando aparecem como deprecated; `GET /api/v1/pagamentos/{osId}` continua documentado para a consulta síncrona usada na entrega. Na Execução, as rotas HTTP internas aparecem como deprecated. As mensagens SQS não são endpoints HTTP, então seus contratos devem ser consultados no [fluxo da ordem](../fluxo-da-ordem.md) e no [runbook da Saga](./operacao-saga-sqs.md).

## Criar dados e autenticar

Em um quarto terminal, a partir do repositório da OS, execute o seed uma vez:

```bash
curl -fsS -X POST http://localhost:3001/api/v1/seeding \
  -H 'Content-Type: application/json' \
  -d '{}' | jq
```

O seed cria dados aleatórios de clientes, veículos, serviços e estoque. Ele também cria usuários de teste com a senha `SeedPassword123!`; o administrador padrão é criado pela migration e usa `admin@oficina.com` / `admin123`. Evite chamar o seed repetidamente: cada execução acrescenta usuários aleatórios.

Faça login e guarde o token de administrador na variável do terminal:

```bash
OS_URL=http://localhost:3001
ADMIN_TOKEN=$(curl -fsS -X POST "$OS_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@oficina.com","password":"admin123"}' \
  | jq -r '.data.token')
```

Liste os dados do seed e escolha um cliente com veículo e um serviço:

```bash
CLIENTES=$(curl -fsS "$OS_URL/api/v1/clientes" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
VEICULOS=$(curl -fsS "$OS_URL/api/v1/veiculos" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
SERVICOS=$(curl -fsS "$OS_URL/api/v1/servicos" \
  -H "Authorization: Bearer $ADMIN_TOKEN")

CLIENTE=$(jq -c '.data[0]' <<<"$CLIENTES")
CLIENTE_ID=$(jq -r '.id' <<<"$CLIENTE")
CLIENTE_DOCUMENTO=$(jq -r '.documento' <<<"$CLIENTE")
VEICULO=$(jq -c --arg id "$CLIENTE_ID" \
  '.data[] | select(.cliente_id == $id)' <<<"$VEICULOS" | head -n 1)
PLACA=$(jq -r '.placa' <<<"$VEICULO")
SERVICO_ID=$(jq -r '.data[0].id' <<<"$SERVICOS")
```

Gere um JWT local de cliente para aprovar o orçamento. Esse token é apenas para o ambiente local e usa `JWT_SECRET` do `.env` da OS:

```bash
CLIENT_TOKEN=$(CLIENTE_ID="$CLIENTE_ID" CLIENTE_DOCUMENTO="$CLIENTE_DOCUMENTO" \
  node -r dotenv/config -e '
    const { JwtService } = require("@nestjs/jwt");
    const jwt = new JwtService({ secret: process.env.JWT_SECRET });
    jwt.signAsync({
      sub: process.env.CLIENTE_ID,
      role: "cliente",
      cpf: process.env.CLIENTE_DOCUMENTO
    }, { expiresIn: "1h" }).then(token => process.stdout.write(token));
  ')
```

Crie uma OS com um serviço e sem peças, para evitar dependência de disponibilidade de estoque:

```bash
OS_RESPONSE=$(curl -fsS -X POST "$OS_URL/api/v1/ordens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg documento "$CLIENTE_DOCUMENTO" \
    --arg placa "$PLACA" \
    --argjson servicoId "$SERVICO_ID" \
    '{documentoCliente:$documento,placa:$placa,itensServico:[{servicoId:$servicoId}],itensPeca:[]}')")
OS_ID=$(jq -r '.data.id' <<<"$OS_RESPONSE")
jq '.data | {id, status, valorTotal}' <<<"$OS_RESPONSE"
```

Se `PLACA` ficar vazia, escolha outro cliente que tenha veículo nas respostas de listagem. Os IDs e documentos do seed são diferentes a cada ambiente.

## Percorrer a Saga

As ações remotas respondem `202 Accepted`. A resposta traz `sagaId` e `commandId`; aguarde a Saga terminar antes de iniciar a próxima ação. Use esta função no mesmo terminal:

```bash
aguardar_saga() {
  local saga_id="$1"
  local token="$2"
  local tentativa status resposta

  for tentativa in {1..60}; do
    resposta=$(curl -fsS "$OS_URL/api/v1/ordens/$OS_ID/sagas/$saga_id" \
      -H "Authorization: Bearer $token") || return 1
    status=$(jq -r '.data.status' <<<"$resposta")

    case "$status" in
      CONCLUIDA)
        jq '.data | {sagaId, status, steps}' <<<"$resposta"
        return 0
        ;;
      FALHA)
        jq '.data | {sagaId, status, steps}' <<<"$resposta" >&2
        return 1
        ;;
    esac
    sleep 1
  done

  echo "Timeout aguardando a Saga $saga_id" >&2
  return 1
}

executar_acao_saga() {
  local acao="$1"
  local token="$2"
  local resposta saga_id

  resposta=$(curl -fsS -X POST "$OS_URL/api/v1/ordens/$OS_ID/$acao" \
    -H "Authorization: Bearer $token") || return 1
  jq '.data' <<<"$resposta"
  saga_id=$(jq -r '.data.sagaId' <<<"$resposta")
  aguardar_saga "$saga_id" "$token"
}
```

Execute nesta ordem e confira o status canônico da OS após cada ação:

```bash
executar_acao_saga iniciar-diagnostico "$ADMIN_TOKEN"
curl -fsS "$OS_URL/api/v1/ordens/$OS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.status'
# Esperado: EM_DIAGNOSTICO

executar_acao_saga gerar-orcamento "$ADMIN_TOKEN"
curl -fsS "$OS_URL/api/v1/ordens/$OS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.status'
# Esperado: AGUARDANDO_APROVACAO

executar_acao_saga aprovar-orcamento "$CLIENT_TOKEN"
curl -fsS "$OS_URL/api/v1/ordens/$OS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.status'
# Esperado: AGUARDANDO_SERVICO (a OS foi criada sem peças)

executar_acao_saga iniciar-execucao "$ADMIN_TOKEN"
curl -fsS "$OS_URL/api/v1/ordens/$OS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.status'
# Esperado: EM_EXECUCAO

executar_acao_saga finalizar "$ADMIN_TOKEN"
curl -fsS "$OS_URL/api/v1/ordens/$OS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.status'
# Esperado: FINALIZADA
```

Na finalização, a Saga só fica `CONCLUIDA` depois de a Execução responder e o Billing abrir o pagamento local pendente. Confira o pagamento com a chamada interna do Billing:

```bash
curl -fsS "http://localhost:3002/api/v1/pagamentos/$OS_ID" \
  -H 'x-saga-token: oficina-local' | jq
```

O status esperado é `PENDENTE`. A OS também pode ser consultada em `GET /api/v1/ordens/$OS_ID/sagas/$SAGA_ID` com o `sagaId` retornado pela ação. O endpoint de Saga mostra o estado técnico e as etapas; o campo `status` da ordem só muda quando a OS processa o resultado correspondente.

## Opcional: checkout e entrega

Para testar também cobrança e entrega, configure `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_PUBLIC_KEY` com credenciais de teste no `.env` do Billing e reinicie o serviço. Abra no navegador:

```text
http://localhost:3002/api/v1/pagamentos/<OS_ID>/checkout
```

Conclua o checkout com um cartão de teste do Mercado Pago. Confirme que o pagamento foi atualizado para `APROVADO` e então entregue a ordem:

```bash
curl -fsS -X POST "$OS_URL/api/v1/ordens/$OS_ID/entregar" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | {id, status}'
# Esperado: ENTREGUE
```

Sem credenciais de teste, pare no estado `FINALIZADA` com pagamento `PENDENTE`; essa etapa já confirma a Saga até a abertura local do pagamento. A cobrança de cartão não é um comando Saga.

## Se algo não avançar

- `202` seguido de `PENDENTE`: confira se Billing e Execução estão rodando com `SQS_WORKER_ENABLED=true`, se a OS está com relay e consumidor de resultados ativos e se os três `.env` apontam às URLs do Floci.
- `409 Conflict`: já existe uma Saga ativa para a OS. Aguarde a consulta de Saga terminar antes de tentar outra ação.
- Saga `FALHA`: consulte seus `steps` e o estado do serviço dono. Use o [runbook da Saga SQS](./operacao-saga-sqs.md) para reconciliação; não edite as tabelas manualmente.
- Health do serviço indisponível ou filas ausentes: veja `docker compose ps` e `docker compose logs floci` no repositório da OS.

Para parar as aplicações, use `Ctrl+C` nos terminais. Para parar os recursos locais, execute `docker compose down` em cada repositório onde iniciou Compose. O diagrama do fluxo está em [fluxo-da-ordem.md](../fluxo-da-ordem.md).
