# Fluxo da ordem de serviço

Três serviços participam. A OS é a dona do status e conduz a sequência. A execução só registra se o diagnóstico ou o reparo está aberto ou concluído. O billing guarda o orçamento e o pagamento, com o `valorTotal` já calculado pela OS. Nenhum serviço lê o banco do outro.

O pagamento acontece na retirada, depois de `FINALIZADA` e antes de `ENTREGUE`. A página de checkout fica no billing. Pagamento aprovado esconde o formulário. Pagamento pendente, já enviado ao Mercado Pago, avisa que aguarda o retorno. Pagamento recusado pede nova tentativa e mantém o formulário. A entrega consulta o billing e só segue se o status local estiver `APROVADO`.

## Status

```mermaid
flowchart TD
  recebida[RECEBIDA] --> diagnostico[EM_DIAGNOSTICO]
  diagnostico --> aprovacao[AGUARDANDO_APROVACAO]
  aprovacao --> aprovada[APROVADA]
  aprovacao --> reprovada[REPROVADA]
  reprovada --> cancelada[CANCELADA]
  aprovada --> servico[AGUARDANDO_SERVICO]
  aprovada --> pecas[AGUARDANDO_PECAS_INSUMOS]
  pecas --> servico
  servico --> execucao[EM_EXECUCAO]
  execucao --> finalizada[FINALIZADA]
  finalizada -->|compensação se falhar abertura do pagamento| execucao
  finalizada --> entregue[ENTREGUE]
```

`AGUARDANDO_PECAS_INSUMOS` aparece quando, na aprovação, a quantidade física não cobre o que já foi reservado. A reposição de estoque tenta liberar essas ordens para `AGUARDANDO_SERVICO`. `CANCELADA` só sai de `REPROVADA`.

O status é eventual em relação às etapas remotas da Saga: a API aceita a ação e persiste a etapa/outbox antes do envio; a ordem permanece com o status anterior enquanto aguarda o resultado. Se a segunda etapa falhar, a OS entra em `COMPENSANDO` e reabre a etapa concluída na Execução. Em `FINALIZAR`, após a confirmação da reabertura, a OS restaura `EM_EXECUCAO`. `FALHA_COMPENSACAO` ou mensagem na DLQ exige reconciliação; consulte o [guia operacional](./operacao-saga-sqs.md).

```mermaid
flowchart LR
  acao[Requisição de ação] --> persistir[Persistir Saga, etapa e outbox]
  persistir --> resposta[Responder 202; status de negócio permanece]
  persistir --> publicar[Relay publica comando SQS]
  publicar --> aplicar[Participante aplica comando idempotente]
  aplicar --> resultado[Resultado chega à OS]
  resultado -->|sucesso| avancar[Atualizar status e histórico]
  resultado -->|falha na primeira etapa| falhar[Saga termina em FALHA]
  resultado -->|falha na segunda etapa| compensar[Persistir EXECUTION_REOPEN na outbox]
  compensar -->|sucesso| compensada[Saga COMPENSADA; restaurar status se necessário]
  compensar -->|falha| reconciliar[FALHA_COMPENSACAO; reconciliar participantes]
```

Os estados acima são o **status de negócio canônico da OS**. A execução da Saga tem estado técnico separado (`PENDENTE`, `EM_PROCESSAMENTO`, `CONCLUIDA`, `FALHA`, `COMPENSANDO`, `COMPENSADA` ou `FALHA_COMPENSACAO`), que não substitui o status da ordem. Cada etapa mantém `PENDENTE`, `EM_PROCESSAMENTO`, `CONCLUIDA` ou `FALHA`.

## Comandos da Saga orquestrada

A OS é o único orquestrador: recebe a ação do ator, persiste a etapa da Saga e publica um comando por SQS. Billing e Execução aplicam somente o comando recebido e devolvem um resultado correlacionado. A OS valida `sagaId`, `commandId`, `osId`, `causationId` e o estado esperado; em caso de sucesso, grava as alterações locais, histórico e status de negócio na mesma transação, e decide se publica outro comando. Um participante nunca escolhe ou publica o próximo comando.

As rotas que iniciam trabalho remoto mantêm seus caminhos e respondem `202 Accepted` com `osId`, `sagaId`, `commandId` e `status: PENDENTE`. A OS bloqueia a linha da ordem durante a aceitação e rejeita com `409 Conflict` outra ação enquanto houver Saga `PENDENTE`, `EM_PROCESSAMENTO`, `COMPENSANDO` ou `FALHA_COMPENSACAO`; assim, duas requisições concorrentes não criam Sagas dependentes em paralelo. Após uma Saga terminal, a próxima ação ainda precisa ser válida para o status canônico atual. O status canônico da OS permanece no estado anterior até o resultado remoto de sucesso ser processado. Consulte `GET /api/v1/ordens/:id/sagas/:sagaId` para acompanhar status e etapas ordenadas; essa rota exige autenticação e consulta a Saga pelo par `osId`/`sagaId`. Resultados repetidos são confirmados sem repetir efeitos locais. Resultado desconhecido, inválido ou sem correspondência não altera a OS e permanece sem confirmação para seguir a política da DLQ.

O grupo FIFO é o `osId`, e a sequência também é validada no Postgres: a primeira etapa é `1` e cada etapa seguinte deve ser contígua. Uma etapa normal só pode ser criada após a anterior concluir. A exceção é `EXECUTION_REOPEN`, criado após a falha da segunda etapa de `GERAR_ORCAMENTO` ou `FINALIZAR`. Ao receber um resultado, a OS confere que os predecessores estão `CONCLUIDA`, exceto a falha imediatamente anterior à compensação. Um resultado fora de ordem não altera status, histórico ou efeitos locais e não é confirmado na fila.

| Ação iniciada       | Comandos emitidos pela OS, em ordem                                                  | Quando a OS grava o status de negócio                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Iniciar diagnóstico | `EXECUTION_OPEN` (`DIAGNOSTICO`)                                                     | Após resultado de sucesso da Execução: `RECEBIDA` → `EM_DIAGNOSTICO`.                                                                                                                             |
| Gerar orçamento     | `EXECUTION_COMPLETE` (`DIAGNOSTICO`), depois `BILLING_QUOTE_GENERATE` (`valorTotal`) | Só após sucesso dos dois comandos: `EM_DIAGNOSTICO` → `AGUARDANDO_APROVACAO`. Falha no Billing reabre o diagnóstico na Execução e termina `COMPENSADA`.                                             |
| Aprovar orçamento   | `BILLING_QUOTE_APPROVE`                                                              | Após sucesso do Billing, a OS aplica a disponibilidade de peças e grava `APROVADA` e o destino local (`AGUARDANDO_SERVICO` ou `AGUARDANDO_PECAS_INSUMOS`) na transação da OS.                     |
| Reprovar orçamento  | `BILLING_QUOTE_REJECT`                                                               | Após sucesso do Billing, a OS estorna as reservas e grava `REPROVADA` na transação da OS.                                                                                                         |
| Iniciar execução    | `EXECUTION_OPEN` (`REPARO`)                                                          | Após sucesso da Execução, a OS dá baixa nas peças e grava `EM_EXECUCAO` na mesma transação local.                                                                                                 |
| Finalizar           | `EXECUTION_COMPLETE` (`REPARO`), depois `BILLING_PAYMENT_OPEN` (`valorTotal`)        | Após sucesso da conclusão do reparo, a OS grava `FINALIZADA`; em seguida orquestra a abertura local do pagamento pendente. O pagamento no Mercado Pago continua no checkout explícito do Billing. |
| Entregar            | Consulta síncrona `GET` do pagamento no Billing                                      | A OS grava `ENTREGUE` somente quando o Billing responde `APROVADO`.                                                                                                                               |

`APROVADA` é um passo de negócio persistido junto com o estado de estoque e com o destino seguinte. Falha da primeira etapa grava `FALHA`; falha da segunda inicia `EXECUTION_REOPEN` na mesma transação em que registra o erro. A abertura de pagamento após `FINALIZADA` é um passo assíncrono; se falhar, a compensação reabre o reparo e restaura `EM_EXECUCAO`. Checkout/cobrança continua explícito no Billing. A entrega permanece síncrona e depende de uma consulta ao Billing que retorne `APROVADO`.

O envelope da versão 1 e os validadores de runtime vivem em `src/saga/contracts/saga-message.ts`. Cada mensagem inclui `messageId`, `commandId`, `sagaId`, `osId`, `type`, `occurredAt`, `correlationId`, `causationId`, `schemaVersion` e `payload`. Os IDs `messageId`, `commandId`, `sagaId` e `osId` são UUIDs; `commandId` identifica a operação idempotente e permanece estável em retry; uma nova publicação pode ter novo `messageId`. O resultado `SAGA_STEP_RESULT` referencia o comando e informa `CONCLUIDA` ou `FALHA`. Mensagens com versão, tipo ou payload inválido são rejeitadas pelo consumidor e seguem a política de retry/DLQ.

## Quem é chamado

```mermaid
sequenceDiagram
  participant Admin
  participant OS
  participant Exec as Execução
  participant Bill as Billing
  participant SQS as Filas SQS FIFO
  participant Cliente

  Cliente->>OS: POST /api/v1/auth/cpf
  OS-->>Cliente: JWT de cliente

  Admin->>OS: iniciar diagnóstico
  OS->>OS: bloqueia linha da OS e verifica Saga ativa
  OS->>OS: grava etapa Saga e outbox
  OS->>SQS: EXECUTION_OPEN (DIAGNOSTICO)
  SQS->>Exec: comando
  Exec->>SQS: SAGA_STEP_RESULT
  SQS->>OS: resultado
  OS->>OS: grava EM_DIAGNOSTICO após sucesso

  Admin->>OS: gerar orçamento
  OS->>SQS: EXECUTION_COMPLETE (DIAGNOSTICO)
  SQS->>Exec: comando
  Exec->>SQS: SAGA_STEP_RESULT
  SQS->>OS: resultado
  OS->>SQS: BILLING_QUOTE_GENERATE (valorTotal)
  SQS->>Bill: comando
  Bill->>SQS: SAGA_STEP_RESULT
  SQS->>OS: resultado
  alt orçamento gerado
    OS->>OS: grava AGUARDANDO_APROVACAO
  else falha na geração
    OS->>SQS: EXECUTION_REOPEN (DIAGNOSTICO)
    SQS->>Exec: comando de compensação
    Exec->>SQS: SAGA_STEP_RESULT
    SQS->>OS: resultado da compensação
    OS->>OS: Saga COMPENSADA ou FALHA_COMPENSACAO
  end

  Cliente->>OS: aprovar ou reprovar
  OS->>OS: compara JWT.sub com OS.cliente_id
  alt aprovado e estoque cobre
    OS->>SQS: BILLING_QUOTE_APPROVE
    SQS->>Bill: comando
    Bill->>SQS: SAGA_STEP_RESULT
    SQS->>OS: resultado
    OS->>OS: grava APROVADA + AGUARDANDO_SERVICO
  else aprovado e falta peça
    OS->>SQS: BILLING_QUOTE_APPROVE
    SQS->>Bill: comando
    Bill->>SQS: SAGA_STEP_RESULT
    SQS->>OS: resultado
    OS->>OS: grava APROVADA + AGUARDANDO_PECAS_INSUMOS
  else reprovado
    OS->>SQS: BILLING_QUOTE_REJECT
    SQS->>Bill: comando
    Bill->>SQS: SAGA_STEP_RESULT
    SQS->>OS: resultado
    OS->>OS: grava REPROVADA e estorna a reserva
  end

  Admin->>OS: iniciar execução
  OS->>SQS: EXECUTION_OPEN (REPARO)
  SQS->>Exec: comando
  Exec->>SQS: SAGA_STEP_RESULT
  SQS->>OS: resultado
  OS->>OS: grava EM_EXECUCAO e baixa o estoque após sucesso

  Admin->>OS: finalizar
  OS->>SQS: EXECUTION_COMPLETE (REPARO)
  SQS->>Exec: comando
  Exec->>SQS: SAGA_STEP_RESULT
  SQS->>OS: resultado
  OS->>OS: grava FINALIZADA após sucesso
  OS->>SQS: BILLING_PAYMENT_OPEN (valorTotal)
  SQS->>Bill: comando
  Bill->>SQS: SAGA_STEP_RESULT
  SQS->>OS: resultado
  alt pagamento aberto
    OS->>OS: Saga CONCLUIDA
  else falha na abertura
    OS->>SQS: EXECUTION_REOPEN (REPARO)
    SQS->>Exec: comando de compensação
    Exec->>SQS: SAGA_STEP_RESULT
    SQS->>OS: resultado da compensação
    OS->>OS: restaura EM_EXECUCAO se compensada
  end

  Cliente->>Bill: paga no checkout
  Bill->>Bill: APROVADO, PENDENTE ou RECUSADO

  Admin->>OS: entregar
  OS->>Bill: consulta o pagamento
  alt APROVADO
    OS->>OS: grava ENTREGUE
  else outro status
    OS-->>Admin: recusa a entrega
  end
```

A porta pública é o API Gateway, e ela não lista cada rota. O proxy geral leva `POST /api/v1/auth/cpf` e o restante da OS: login de administrador, cadastro e ordem. No billing, só o checkout e a cobrança atravessam o gateway, sem escolher perfil: o dono do veículo e o administrador usam os dois. Orçamento, execução e a abertura do pagamento ficam fora dessa borda. A OS chama esses serviços direto.

O status canônico que depende de um comando remoto só é gravado após o resultado de sucesso. A etapa e a outbox são persistidas primeiro para que a OS possa retomar a operação após falha ou reinício. Cada consumidor aplica comandos idempotentemente; resultados duplicados não repetem a transição nem o histórico. Estorno no Mercado Pago não faz parte deste fluxo. A decisão de consultar o pagamento, em vez de receber webhook, está na [ADR 002](./adr/002-consulta-ativa-do-pagamento.md). A divisão dos serviços está na [ADR 001](./adr/001-divisao-dos-servicos-e-banco-por-aplicacao.md). O que entra no gateway, e por que o corpo não é cifrado de novo, está na [ADR 003](./adr/003-borda-publica-do-gateway.md).

A política de ativação, compatibilidade do envelope e tratamento de `FALHA`/DLQ está na [ADR 004](./adr/004-operacao-saga-sqs.md) e no [guia operacional](./operacao-saga-sqs.md).
