import { registerAs } from '@nestjs/config';
import * as Joi from 'joi';

export interface AppConfig {
  environment: string;
  port: number;
}

export const appConfig = registerAs('app', (): AppConfig => ({
  environment: process.env.NODE_ENV ?? 'development',
  port: Number.parseInt(process.env.APP_PORT ?? '3001', 10),
}));

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  APP_PORT: Joi.number().default(3001),
  BILLING_BASE_URL: Joi.string().default('http://localhost:3002'),
  EXECUCAO_BASE_URL: Joi.string().default('http://localhost:3003'),
  SAGA_TOKEN: Joi.string().default('oficina-local'),
  POSTGRES_HOST: Joi.string().default('localhost'),
  POSTGRES_PORT: Joi.number().default(5432),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SYNC: Joi.number().valid(0, 1).required(),
  POSTGRES_SSL: Joi.number().valid(0, 1).default(0),
  POSTGRES_SSL_REJECT_UNAUTHORIZED: Joi.number().valid(0, 1).default(0),
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
  RESEND_API_KEY: Joi.string().required(),
  RESEND_FROM: Joi.string().email().default('onboarding@resend.dev'),
  RESEND_DEV_REDIRECT_TO: Joi.string().email().optional(),
  NOTIFICACAO_EMAIL_MECANICOS: Joi.string().email().required(),
  NOTIFICACAO_EMAIL_ADMIN: Joi.string().email().required(),
  SQS_ENDPOINT_URL: Joi.string().uri().allow('').optional(),
  SQS_REGION: Joi.string().default('us-east-1'),
  SQS_BILLING_COMMAND_QUEUE_URL: Joi.string()
    .uri()
    .when('SQS_OUTBOX_RELAY_ENABLED', {
      is: true,
      then: Joi.required(),
    }),
  SQS_EXECUTION_COMMAND_QUEUE_URL: Joi.string()
    .uri()
    .when('SQS_OUTBOX_RELAY_ENABLED', {
      is: true,
      then: Joi.required(),
    }),
  SQS_RESULTS_QUEUE_URL: Joi.string()
    .uri()
    .when('SQS_OUTBOX_RELAY_ENABLED', { is: true, then: Joi.required() })
    .when('SQS_RESULTS_CONSUMER_ENABLED', { is: true, then: Joi.required() }),
  SQS_OUTBOX_RELAY_ENABLED: Joi.boolean().default(false),
  SQS_RESULTS_CONSUMER_ENABLED: Joi.boolean().default(false),
  SQS_OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(250).default(1000),
  SQS_OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(10).default(10),
  SQS_OUTBOX_LEASE_MS: Joi.number().integer().min(1000).default(30000),
});
