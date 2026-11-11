import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSagaPersistence1794000000000 implements MigrationInterface {
  name = 'CreateSagaPersistence1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "saga_execution" (
        "id" uuid NOT NULL,
        "os_id" uuid NOT NULL,
        "action" character varying(64) NOT NULL,
        "requested_by" uuid,
        "status" character varying(32) NOT NULL DEFAULT 'PENDENTE',
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_saga_execution" PRIMARY KEY ("id"),
        CONSTRAINT "FK_saga_execution_ordem_servico" FOREIGN KEY ("os_id") REFERENCES "ordem_servico" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_saga_execution_status" CHECK ("status" IN ('PENDENTE', 'EM_PROCESSAMENTO', 'CONCLUIDA', 'FALHA'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saga_execution_os_id" ON "saga_execution" ("os_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "saga_step" (
        "command_id" uuid NOT NULL,
        "saga_id" uuid NOT NULL,
        "sequence" integer NOT NULL,
        "command_type" character varying(64) NOT NULL,
        "destination" character varying(16) NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'PENDENTE',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "retryable" boolean NOT NULL DEFAULT false,
        "last_error_code" character varying(128),
        "last_error_message" text,
        "result" jsonb,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completed_at" TIMESTAMP(3),
        CONSTRAINT "PK_saga_step" PRIMARY KEY ("command_id"),
        CONSTRAINT "FK_saga_step_saga_execution" FOREIGN KEY ("saga_id") REFERENCES "saga_execution" ("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_saga_step_saga_sequence" UNIQUE ("saga_id", "sequence"),
        CONSTRAINT "CHK_saga_step_sequence" CHECK ("sequence" > 0),
        CONSTRAINT "CHK_saga_step_destination" CHECK ("destination" IN ('BILLING', 'EXECUCAO')),
        CONSTRAINT "CHK_saga_step_status" CHECK ("status" IN ('PENDENTE', 'EM_PROCESSAMENTO', 'CONCLUIDA', 'FALHA'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saga_step_saga_id" ON "saga_step" ("saga_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "saga_outbox" (
        "message_id" uuid NOT NULL,
        "command_id" uuid NOT NULL,
        "destination" character varying(16) NOT NULL,
        "body" jsonb NOT NULL,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "locked_until" TIMESTAMP(3),
        "published_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_saga_outbox" PRIMARY KEY ("message_id"),
        CONSTRAINT "UQ_saga_outbox_command_id" UNIQUE ("command_id"),
        CONSTRAINT "FK_saga_outbox_saga_step" FOREIGN KEY ("command_id") REFERENCES "saga_step" ("command_id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_saga_outbox_destination" CHECK ("destination" IN ('BILLING', 'EXECUCAO'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saga_outbox_pending" ON "saga_outbox" ("available_at", "destination") WHERE "published_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "saga_outbox"`);
    await queryRunner.query(`DROP INDEX "IDX_saga_step_saga_id"`);
    await queryRunner.query(`DROP TABLE "saga_step"`);
    await queryRunner.query(`DROP INDEX "IDX_saga_execution_os_id"`);
    await queryRunner.query(`DROP TABLE "saga_execution"`);
  }
}
