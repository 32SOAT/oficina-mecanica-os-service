# ADR 003 — Borda pública do gateway

| Campo | Valor |
| --- | --- |
| Data | 27/10/2026 |
| Status | Aceita |
| Decisores | Grupo 32SOAT: Allan Kayan Gadioli Alves, Gustavo de Matos Parizi, Isaac Bruno Siqueira de Souza, João Ricardo Bianchini Vieira, Juliana Silveira Amorim do Nascimento |

## Contexto

O API Gateway é a porta única. Na fase 3, `POST /auth/cpf` ia para a Lambda e `ANY /{proxy+}` levava o restante ao monólito. Não havia uma rota por endpoint.

Na fase 4 o fluxo atravessa três serviços. A OS conduz a saga. Billing e execução não são chamados pela pessoa: a OS os chama depois de gravar o status, com `x-saga-token`. A Lambda consulta o cliente na OS pelo mesmo tipo de chamada, em `POST /api/v1/clientes/consulta-auth`.

O que uma pessoa abre é outro conjunto. O dono do veículo autentica com CPF. O administrador entra pelo login da OS. Os dois usam o checkout e a cobrança da retirada. O cartão não chega ao nosso servidor: o Brick do Mercado Pago troca o cartão por um token no navegador, e o Access Token fica só no billing.

## Decisão

O gateway publica só a borda humana. Não cadastramos cada rota interna.

| Entrada | Destino |
| --- | --- |
| `POST /auth/cpf` | Lambda |
| `GET /api/v1/pagamentos/{osId}/checkout` e `POST /api/v1/pagamentos/{osId}/cobrar` | Billing |
| `ANY /{proxy+}` | OS: login de administrador, cadastro, ordem, health e Swagger |

Checkout e cobrança não têm authorizer. O dono do veículo e o administrador usam a mesma página.

Orçamento, execução, abertura do pagamento, confirmação, recusa e a consulta de cliente da Lambda ficam fora do gateway. A OS e a Lambda chamam esses endereços direto, com o token da saga.

Não criptografamos de novo o que já atravessa essa borda. O cliente fala com o API Gateway por HTTPS. O JWT vai assinado nesse canal. O número do cartão não é dado nosso. Criptografar o JSON por cima do TLS, ou esconder o `osId` do checkout, não reduz o que está exposto e quebra o cliente e a página.

O trecho que ainda não tem TLS é o salto do API Gateway até o NLB, hoje em `http://`. Quando o billing e a OS tiverem listener HTTPS no balanceador, a integração passa a usar `https://`. Isso é configuração do canal, não criptografia de cada campo.

## Consequências

- O token da saga não precisa ser publicado na internet para o fluxo da pessoa funcionar.
- Uma rota nova da OS continua saindo pelo proxy geral, sem mudança no gateway.
- Uma rota nova de billing ou execução só entra no gateway se uma pessoa precisar abri-la.
- O checkout segue alcançável por quem tem o endereço da ordem. A proteção é o canal HTTPS e o fato de o cartão ser tokenizado no Mercado Pago.
- Enquanto o NLB for HTTP, o miolo entre o gateway e o balanceador não está cifrado. O corpo já chegou cifrado até o gateway.

## Alternativas consideradas

**Uma rota no gateway para cada endpoint.** O gateway passaria a conhecer o contrato inteiro dos três serviços. Health, Swagger e o cadastro mudariam o Terraform a cada rota. A fase 3 já tinha descartado isso.

**Publicar também orçamento e execução.** A borda ficaria com o token da saga. Quem alcança o gateway poderia chamar a saga se o token vazasse. Essas chamadas não são de pessoa.

**Criptografar o corpo ou o JWT (JWE) além do HTTPS.** O navegador, a Lambda e a OS teriam de cifrar e decifrar cada mensagem. O TLS da borda já esconde o conteúdo no caminho até o gateway. O cartão já não passa por nós.

**VPC Link entre o gateway e o balanceador.** Tiraria o NLB da internet. O recorte desta fase não inclui VPC Link, certificado nem listener HTTPS. O passo simples, quando a nuvem estiver no ar, é HTTPS no NLB.
