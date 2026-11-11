import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('OS Service')
    .setDescription(
      'API da ordem de serviço. Ações remotas com Billing e Execução são assíncronas via SQS e retornam 202 com identificadores da Saga; consulte o estado pela rota de Saga. A entrega mantém a consulta síncrona do pagamento no Billing.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT de admin (POST /auth/login) ou de cliente (Lambda POST /auth/cpf). Rotas da oficina exigem role admin. No Swagger UI, clique em Authorize e cole apenas o token.',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);
}
