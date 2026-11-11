# ADR 004: ativação e recuperação operacional da Saga SQS

## Status

Aceita

## Contexto

A OS conduz uma Saga assíncrona com outbox e resultados por SQS FIFO. A API pode aceitar e persistir uma ação mesmo quando o relay de publicação está desligado. O status de negócio só muda depois do resultado remoto de sucesso. Falhas de transporte, mensagens em DLQ e falhas de negócio exigem reconciliação entre a OS e o serviço dono do efeito.

## Decisões

- Habilitar em duas fases: provisionar filas/DLQs e permissões, iniciar Billing/Execução e o consumidor de resultados da OS; depois habilitar o relay da outbox da OS.
- Antes de uma janela com relay desligado, suspender a entrada de novas ações Saga. A aplicação não bloqueia essas ações e a outbox pode acumular; não há fallback HTTP de comando.
- Manter o status canônico da OS no estado anterior até processar resultado remoto de sucesso. Em falha ou reconciliação, consultar Saga e participante antes de qualquer replay.
- Não incluir endpoint de retry/redrive nesta entrega. Não alterar estados persistidos manualmente; nova ação deve respeitar a transição canônica e o gate de Saga ativa.
- Não adicionar CloudWatch nem outro coletor. Acompanhar operação com logs seguros por identificador, estado persistido e atributos/inspeção das filas. Em desenvolvimento local, usar Floci.
- Preservar configurações atuais de retenção, visibilidade, redrive e retry até revisão operacional separada.
- Evoluir mensagens com rollout expand/contract, garantindo consumidores compatíveis antes de publicar uma nova versão do envelope.

## Consequências

O fluxo é eventualmente consistente entre comandos remotos e o status canônico. Uma Saga em `FALHA` não avança o status e não possui retry automatizado de negócio. Redrive em SQS pode mover um conjunto de mensagens da DLQ; só é seguro quando todas as mensagens da fila selecionadas para redrive foram reconciliadas. Comandos de pagamento exigem verificação no Mercado Pago antes do redrive. Os procedimentos detalhados estão no [guia de operação da Saga SQS](../operacao-saga-sqs.md).
