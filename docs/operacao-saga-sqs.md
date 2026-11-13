# Runbook: operação da Saga SQS

Este procedimento cobre rollout, acompanhamento e reconciliação operacional da Saga orquestrada pela OS. A OS é a fonte do status de negócio; Billing e Execução são donos dos efeitos e registros locais. Não atualize tabelas manualmente para “destravar” uma Saga.

## Rollout

Faça a ativação em duas fases. Planeje uma janela controlada para habilitar o relay: a API da OS ainda aceita ações Saga com `SQS_OUTBOX_RELAY_ENABLED=false` e persiste a etapa e a mensagem na outbox. Portanto, ações aceitas durante essa janela acumulam como pendentes e não têm fallback HTTP. Suspenda ou bloqueie o início de novas ações Saga na operação durante a preparação e até a confirmação do fluxo; não há uma flag de aplicação que faça esse bloqueio.

### Fase 1: filas, permissões e consumidores

1. Crie filas FIFO, DLQs e políticas IAM conforme o módulo em `infra/sqs`. Em AWS, revise `terraform plan` com os nomes das roles existentes e aplique somente pelo processo de mudança autorizado para o ambiente. Em local, suba Postgres e Floci pelo compose da OS; o script de init cria as filas.
2. Configure em cada serviço a região e as URLs da fila. Em AWS, deixe `SQS_ENDPOINT_URL` ausente e use credenciais temporárias da role; não grave chaves AWS nos arquivos `.env`.
3. Implante Billing e Execução com `SQS_WORKER_ENABLED=true`. Implante a OS com `SQS_RESULTS_CONSUMER_ENABLED=true` e `SQS_OUTBOX_RELAY_ENABLED=false`. Confirme que os três serviços iniciaram e que filas e permissões estão acessíveis.
4. Mantenha a entrada de novas ações Saga suspensa até habilitar o relay na fase 2. A consulta síncrona `GET` do pagamento no Billing, usada pela entrega, permanece ativa e não depende do worker SQS.

### Fase 2: publicação da OS

1. Confirme que os consumidores da fase 1 estão saudáveis e que a fila de resultados está configurada.
2. Habilite `SQS_OUTBOX_RELAY_ENABLED=true` na OS. Valores configuráveis atuais: `SQS_OUTBOX_POLL_INTERVAL_MS=1000`, `SQS_OUTBOX_BATCH_SIZE=10` e `SQS_OUTBOX_LEASE_MS=30000`.
3. Execute uma ação Saga controlada e acompanhe `GET /api/v1/ordens/:id/sagas/:sagaId`. Confirme comando, resultado e status canônico após sucesso.
4. Reabra o tráfego normal somente depois da confirmação. Registre a janela e os `osId`, `sagaId` e `commandId` usados na validação.

### Pausa e rollback

Desabilitar o relay interrompe novas publicações, mas não rejeita ações na API: a outbox continua acumulando. Se precisar pausar, suspenda antes a entrada de novas ações Saga, anote o horário e os identificadores, e acompanhe os registros não publicados. Não deixe o relay desligado enquanto aceita esse tráfego sem uma decisão explícita sobre a fila pendente. Não reverta para chamadas HTTP de comando: esse caminho foi removido. A consulta de pagamento para entrega continua síncrona.

## Valores e comportamento de retry

| Componente                  | Configuração atual                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Relay da outbox OS          | Poll de 1 s, lote de até 10 e lease de 30 s                                               |
| Falha ao publicar da outbox | Backoff exponencial iniciado em 1 s, limitado a 60 s; sem limite automático de tentativas |
| SQS principal               | Long polling de 20 s, visibilidade de 60 s, retenção de 4 dias                            |
| DLQ                         | Retenção de 14 dias; mensagem movida após 5 recebimentos                                  |
| Criptografia                | SSE-SQS nas filas principais e DLQs                                                       |

Uma falha de negócio registrada pelo participante como `FALHA` encerra a etapa. Quando a segunda etapa de `GERAR_ORCAMENTO` ou `FINALIZAR` falha, a OS entra em `COMPENSANDO` e publica `EXECUTION_REOPEN`; o resultado bem sucedido encerra a Saga como `COMPENSADA`. Uma falha na primeira etapa encerra a Saga como `FALHA`. Uma falha de compensação deixa `FALHA_COMPENSACAO` e bloqueia novas ações até reconciliação. O retry de transporte do SQS não transforma falha de negócio em nova ação. Mensagem inválida ou falha transitória não confirmada pode ser entregue novamente e, depois de cinco recebimentos, seguir para DLQ. Consumidores rejeitam `schemaVersion` não suportada. Implante a Execução que aceita `EXECUTION_REOPEN` antes de habilitar a OS que o publica.

## Acompanhamento e inspeção

Use `osId`, `sagaId` e `commandId` para correlacionar a consulta da API, logs dos serviços, outbox e mensagem. Registre apenas IDs e códigos de erro em chamados/logs operacionais; não copie bodies de mensagem, dados pessoais nem detalhes de pagamento.

No banco da OS, as consultas abaixo são somente leitura. Execute com acesso operacional aprovado e sem selecionar `body`, `context`, `result` ou `last_error_message`:

```sql
-- Mensagens da outbox que ainda não foram publicadas
SELECT message_id, command_id, destination, attempt_count, available_at,
       locked_until, created_at
FROM saga_outbox
WHERE published_at IS NULL
ORDER BY available_at;

-- Sagas com falha ou ainda em andamento
SELECT id AS saga_id, os_id, action, status, created_at, updated_at
FROM saga_execution
WHERE status IN ('PENDENTE', 'EM_PROCESSAMENTO', 'FALHA', 'COMPENSANDO', 'FALHA_COMPENSACAO')
ORDER BY updated_at;

-- Etapas e códigos de erro para uma Saga específica
SELECT command_id, sequence, command_type, destination, status,
       attempt_count, retryable, last_error_code, created_at, updated_at
FROM saga_step
WHERE saga_id = '<sagaId>'
ORDER BY sequence;
```

Para verificar atributos aproximados da fila sem consumir mensagens, use o AWS CLI com a URL da fila correta:

```bash
aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible RedrivePolicy VisibilityTimeout MessageRetentionPeriod ReceiveMessageWaitTimeSeconds
```

Em local, use o mesmo comando com `--endpoint-url http://localhost:4566`. Atributos `Approximate*` são estimativas; combine-os com a consulta da outbox e com o estado da Saga. Para inspecionar uma DLQ, identifique primeiro o ambiente e a fila correspondente. `receive-message` altera temporariamente a visibilidade e aumenta a contagem de recebimentos; faça a leitura em terminal controlado, restrinja os dados apresentados e não copie o body para logs ou chamados.

## Reconciliação de `FALHA` e DLQ

1. Consulte a Saga e as etapas pela API da OS e registre `osId`, `sagaId`, `commandId`, status e códigos de erro.
2. Consulte o estado real no serviço dono: Execução para diagnóstico/reparo; Billing para orçamento ou pagamento. Determine se o comando teve efeito, se foi deduplicado e se o resultado chegou a ser publicado.
3. Para mensagens na DLQ, compare os IDs com esses registros e classifique a causa antes de qualquer replay. Corrija primeiro configuração, permissão ou incompatibilidade de contrato.
4. O redrive SQS move mensagens da DLQ de volta à fila de origem como operação da fila; ele não seleciona um `commandId`. Use o redrive em lote somente quando todas as mensagens elegíveis daquela DLQ tiverem sido revisadas e forem seguras para reprocessar. Se houver mensagens mistas ou não reconciliadas, não inicie redrive em lote. Com autorização operacional e a revisão concluída, a chamada é:

   ```bash
   aws sqs start-message-move-task \
     --source-arn "$DLQ_ARN" \
     --destination-arn "$SOURCE_QUEUE_ARN"
   ```

   Acompanhe o task handle retornado com `aws sqs list-message-move-tasks --source-arn "$DLQ_ARN"`. Esta entrega não inclui endpoint para redrive individual ou retry de Saga. Se for necessário replay individual, não republique o body manualmente: reconcilie com as equipes donas do serviço e use apenas procedimento aprovado que preserve `commandId` e deduplicação.

5. Não altere manualmente `saga_execution`, `saga_step` ou `saga_outbox`. `FALHA` e `COMPENSADA` são terminais; `COMPENSANDO` indica compensação pendente. `FALHA_COMPENSACAO` bloqueia novas ações até reconciliação do estado real da OS e da Execução. Uma nova ação de negócio precisa respeitar a transição canônica da OS.

Antes de redrive de qualquer comando relacionado a pagamento, consulte o estado atual no Mercado Pago e reconcilie com o pagamento local do Billing. A abertura local do pagamento pendente é idempotente por `commandId`; cobrança de cartão ocorre apenas pelo checkout explícito e não é uma etapa da Saga.

## Evolução do envelope

O contrato atual é `schemaVersion: 1`. Não publique uma versão que algum consumidor implantado ainda rejeite. Para evoluir: primeiro implante consumidores que aceitem a forma antiga e a nova sem quebrar a antiga; depois habilite produtores para emitir a nova forma; por fim, retire compatibilidade antiga somente depois de drenar filas e DLQs que ainda possam conter mensagens anteriores. Este rollout expand/contract evita que deploys parciais convertam mensagens válidas em DLQ. Nenhuma versão 2 é criada por este runbook.

## Sinais operacionais

Esta operação não adiciona CloudWatch ou outro coletor de métricas. Use logs existentes com IDs seguros, estado da Saga/outbox no Postgres, atributos aproximados das filas e inspeção controlada de DLQ. A métrica de negócio existente é independente deste acompanhamento técnico.
