# ADR 004: ativação e recuperação operacional da Saga SQS

## Status

Aceita

## Contexto

A OS conduz uma Saga assíncrona com outbox e resultados por SQS FIFO. A API pode aceitar e persistir uma ação mesmo quando o relay de publicação está desligado. O status de negócio só muda depois do resultado remoto de sucesso. Falhas de transporte, mensagens em DLQ e falhas de negócio exigem reconciliação entre a OS e o serviço dono do efeito.

## Decisões

- Habilitar em duas fases: provisionar filas/DLQs e permissões, iniciar Billing/Execução e o consumidor de resultados da OS; depois habilitar o relay da outbox da OS.
- Antes de uma janela com relay desligado, suspender a entrada de novas ações Saga. A aplicação não bloqueia essas ações e a outbox pode acumular; não há fallback HTTP de comando.
- Manter o status canônico da OS no estado anterior até processar resultado remoto de sucesso. Se o Billing falhar após a conclusão do diagnóstico ou reparo, persistir `EXECUTION_REOPEN` e o estado `COMPENSANDO` na mesma transação. Após a reabertura do reparo, restaurar `EM_EXECUCAO` e registrar o histórico. Em falha de compensação ou reconciliação, consultar Saga e participante antes de qualquer replay.
- Não incluir endpoint de retry/redrive nesta entrega. Não alterar estados persistidos manualmente; nova ação deve respeitar a transição canônica e o gate de Saga ativa.
- Não adicionar CloudWatch nem outro coletor. Acompanhar operação com logs seguros por identificador, estado persistido e atributos/inspeção das filas. Em desenvolvimento local, usar Floci.
- Preservar configurações atuais de retenção, visibilidade, redrive e retry até revisão operacional separada.
- Evoluir mensagens com rollout expand/contract, garantindo consumidores compatíveis antes de publicar uma nova versão do envelope.

## Consequências

O fluxo é eventualmente consistente entre comandos remotos e o status canônico. A Saga pode encerrar em `FALHA` sem efeito anterior, em `COMPENSADA` após desfazer a conclusão na Execução, ou em `FALHA_COMPENSACAO` se a reabertura falhar. Esta última bloqueia novas ações. Redrive em SQS pode mover um conjunto de mensagens da DLQ; só é seguro quando todas as mensagens da fila selecionadas para redrive foram reconciliadas. Comandos de pagamento exigem verificação no Mercado Pago antes do redrive. Os procedimentos detalhados estão no [guia de operação da Saga SQS](../operacao-saga-sqs.md).

As ações com apenas um comando remoto não têm etapa anterior a compensar quando o participante responde `FALHA`: Billing grava sua mutação e marcador de comando em uma transação Postgres; Execução faz o mesmo em uma transação DynamoDB. A OS só aplica seus efeitos locais depois do resultado de sucesso. As duas ações com dois comandos remotos são as que exigem `EXECUTION_REOPEN` quando o segundo comando falha. Falhas de transporte sem resultado confirmado seguem a política de retry/DLQ e exigem reconciliação antes de replay.
