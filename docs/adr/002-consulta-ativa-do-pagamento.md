# ADR 002 — Consulta ativa do pagamento em vez de webhook

| Campo | Valor |
| --- | --- |
| Data | 22/10/2026 |
| Status | Aceita |
| Decisores | Grupo 32SOAT: Allan Kayan Gadioli Alves, Gustavo de Matos Parizi, Isaac Bruno Siqueira de Souza, João Ricardo Bianchini Vieira, Juliana Silveira Amorim do Nascimento |

## Contexto

O billing cobra a retirada no Mercado Pago, no Checkout Transparente via Orders. A resposta imediata da order já grava `APROVADO`, `RECUSADO` ou `PENDENTE`. Um pagamento que permanece `PENDENTE` pode mudar depois, quando o Mercado Pago conclui a análise.

A forma usual de receber essa mudança é um webhook: o Mercado Pago faz um POST HTTPS na URL da aplicação. Isso exige o billing publicado e ligado no momento da notificação. O ambiente em nuvem desta fase não fica no ar o tempo todo, por causa do consumo. Uma notificação enviada com a aplicação desligada se perde, e o pagamento local continuaria `PENDENTE` mesmo depois de aprovado no Mercado Pago.

## Decisão

O billing consulta o Mercado Pago. Não há webhook.

Enquanto o processo está no ar, a cada 10 minutos (`MERCADOPAGO_POLL_INTERVAL_MS`, em milissegundos, padrão `600000`) ele busca os pagamentos locais ainda `PENDENTE` que já têm order e chama `GET /v1/orders/{id}`. A mesma consulta acontece ao ler um pagamento pendente, para a retirada não esperar o próximo ciclo. A order aprovada passa a `APROVADO`; a recusada passa a `RECUSADO`. Se o Mercado Pago estiver indisponível, o status local permanece e a tentativa seguinte repete a consulta.

O estado consultado é o da order no Mercado Pago. Desligar o billing não perde a atualização: na próxima subida, a consulta alcança o que mudou enquanto a aplicação estava fora.

## Consequências

- A entrega continua dependendo de `APROVADO` no billing. A OS não fala com o Mercado Pago.
- O Access Token continua só no billing.
- Não é preciso expor uma URL pública para notificação.
- A atualização de um pagamento pendente espera o billing estar ligado e a próxima consulta. Com a aplicação no ar, isso ocorre em até 10 minutos, ou na hora em que a OS consulta o pagamento para entregar.
- Estorno no Mercado Pago continua fora desta decisão.

## Alternativas consideradas

**Webhook.** O Mercado Pago avisaria a aplicação. A URL precisaria ser HTTPS e estar de pé a cada notificação. Com o ambiente desligado por consumo, o aviso não teria quem receber.

**Consultar só na hora da entrega.** Também evita o webhook, mas o status local ficaria `PENDENTE` até alguém tentar entregar. A consulta periódica atualiza o pagamento mesmo sem essa tentativa.
