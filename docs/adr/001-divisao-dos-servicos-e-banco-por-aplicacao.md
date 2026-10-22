# ADR 001 — Divisão dos serviços e banco em cada aplicação

| Campo | Valor |
| --- | --- |
| Data | 21/10/2026 |
| Status | Aceita |
| Decisores | Grupo 32SOAT: Allan Kayan Gadioli Alves, Gustavo de Matos Parizi, Isaac Bruno Siqueira de Souza, João Ricardo Bianchini Vieira, Juliana Silveira Amorim do Nascimento |

## Contexto

A fase 3 entregou um monólito NestJS (`oficina-mecanica-api`) com um Postgres compartilhado, descrito no repositório `oficina-mecanica-infra-db`. A fase 4 pede pelo menos três microsserviços, cada um com repositório, infraestrutura e banco próprios, sem leitura cruzada de banco, e pelo menos um SQL e um NoSQL.

O fluxo da oficina continua linear: abrir a ordem, diagnosticar, orçar, aprovar ou reprovar, executar, finalizar, cobrar na retirada e entregar. O status canônico e o histórico precisam de um único dono. Estoque, preço de mão de obra e total do orçamento são calculados na mesma transação da ordem.

Há dois significados diferentes para a palavra serviço:

- o **catálogo de mão de obra** (`servico`: nome, descrição e `precoMaoDeObra`), usado para montar o orçamento;
- a **execução do trabalho** (diagnóstico e reparo), que é uma etapa da ordem, sem preço.

## Decisão

Ficam três aplicações. Cada uma publica a própria API, sobe o próprio banco e não acessa o banco das outras. A OS orquestra o fluxo por HTTP. O header `x-saga-token` identifica essa chamada de serviço para serviço. Mercado Pago fica fora desta decisão.

### OS Service

Dono da ficha da ordem e do que a ficha precisa para nascer e ser cobrada.

- Cliente, veículo, usuário e autenticação de administrador.
- Catálogo de mão de obra e estoque, inclusive reserva, espera de peça e baixa.
- Status canônico, histórico e notificações por e-mail.
- Cálculo de `valorTotal` dentro da transação da ordem.
- Condução do fluxo: depois de gravar o status, chama execução e billing.

O catálogo de mão de obra permanece aqui. O preço entra no total do orçamento junto com as peças. Mover esse cadastro para a execução obrigaria a OS a consultar outro serviço só para precificar, e misturaria tabela de preço com o registro de que um diagnóstico ou um reparo está aberto.

### Execução Service

Dono do trabalho realizado, não do catálogo nem do status da oficina.

- Uma linha por ordem e etapa: `DIAGNOSTICO` ou `REPARO`.
- Status da etapa: `ABERTA` ou `CONCLUIDA`.
- A OS abre a etapa e depois a conclui. A execução não lê estoque, não lê o catálogo e não altera o status da ordem.

### Billing Service

Dono do dinheiro combinado e do pagamento local.

- Orçamento com o `valorTotal` já calculado pela OS: `GERADO`, `APROVADO` ou `REPROVADO`.
- Pagamento da retirada: `PENDENTE`, `APROVADO` ou `RECUSADO`.
- A OS só muda para `ENTREGUE` depois de consultar o pagamento e encontrá-lo `APROVADO`.

### Saga

A saga é orquestrada pela OS. O fluxo é uma sequência e o status mora na OS. Coreografia espalharia a decisão de avançar ou compensar entre os três serviços.

Compensação desta etapa: pagamento recusado mantém a ordem em `FINALIZADA` e bloqueia a entrega. Reprovar o orçamento estorna a reserva de estoque e segue a máquina de status já existente (`REPROVADA`, depois `CANCELADA`). Estorno no Mercado Pago não faz parte desta decisão.

### Banco em cada aplicação

O banco sobe no repositório da aplicação que o usa. `oficina-mecanica-infra-db` continua sendo o Postgres único da fase 3 até o corte. Não recebe os schemas novos.

| Aplicação | Banco local | Porta no host | Schema |
| --- | --- | --- | --- |
| OS | Postgres `oficina_os` | 5435 | migrations |
| Billing | Postgres `oficina_billing` | 5433 | sincronizado na subida, por enquanto |
| Execução | Postgres `oficina_execucao` | 5434 | sincronizado na subida, por enquanto |

A porta 5432 permanece com o banco do monólito. Na AWS, OS e billing seguem em Postgres. A execução passa para DynamoDB, que é o NoSQL exigido. Até lá, o contrato local da execução é o mesmo: etapa e status por `osId`.

Nenhum serviço abre conexão com o banco de outro. O que precisa cruzar a fronteira viaja no corpo HTTP: `osId`, etapa e `valorTotal`.

## Consequências

- Cada serviço pode mudar o próprio schema sem migrar o banco dos outros.
- A OS continua o único lugar que responde "em que ponto está o carro".
- O catálogo e o estoque continuam consistentes com o total do orçamento, porque os três são gravados na mesma transação.
- A execução pode trocar Postgres por DynamoDB sem levar cliente, peça ou preço junto.
- Enquanto a chamada remota acontece depois do commit da OS, uma falha de rede deixa o status gravado e a etapa remota pendente. As criações remotas são idempotentes para permitir nova tentativa.
- O requisito de 80% de cobertura da fase 4 ainda não está cumprido na OS: o domínio foi copiado sem a suíte antiga de testes.

## Alternativas consideradas

**Catálogo de mão de obra na execução.** A execução passaria a guardar preço. O orçamento dependeria de uma consulta extra e o serviço de trabalho deixaria de ser só o registro da etapa.

**Um banco só no `oficina-mecanica-infra-db`, com um schema por serviço.** Continua um ponto único de migration e de deploy de banco. A fase 4 pede banco por serviço e proíbe acesso cruzado. Separar schema no mesmo RDS não dá essa independência.

**Coreografia.** Cada serviço reagiria ao evento do anterior. O status canônico ficaria repartido e a compensação da retirada ficaria mais difícil de mostrar e de testar.

**Cobrar antes do reparo.** O enunciado segue abertura, orçamento, aprovação e execução. A cobrança acontece na retirada, depois de `FINALIZADA` e antes de `ENTREGUE`.

## Evolução prevista

Mensageria (SQS), DynamoDB na execução, Mercado Pago, deploy em Kubernetes e a Lambda de CPF passando a chamar a OS por HTTP em vez de ler a tabela de cliente. Essas etapas não alteram o dono de cada dado definido aqui.
