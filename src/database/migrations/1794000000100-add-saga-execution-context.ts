import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaExecutionContext1794000000100 implements MigrationInterface {
  name = 'AddSagaExecutionContext1794000000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "saga_execution"
      ADD COLUMN "context" jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "saga_execution" DROP COLUMN "context"`,
    );
  }
}
