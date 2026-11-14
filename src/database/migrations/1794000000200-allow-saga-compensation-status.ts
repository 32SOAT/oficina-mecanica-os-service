import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowSagaCompensationStatus1794000000200 implements MigrationInterface {
  name = 'AllowSagaCompensationStatus1794000000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "saga_execution" DROP CONSTRAINT "CHK_saga_execution_status"',
    );
    await queryRunner.query(`
      ALTER TABLE "saga_execution"
      ADD CONSTRAINT "CHK_saga_execution_status"
      CHECK ("status" IN (
        'PENDENTE', 'EM_PROCESSAMENTO', 'CONCLUIDA', 'FALHA',
        'COMPENSANDO', 'COMPENSADA', 'FALHA_COMPENSACAO'
      ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "saga_execution" DROP CONSTRAINT "CHK_saga_execution_status"',
    );
    await queryRunner.query(`
      ALTER TABLE "saga_execution"
      ADD CONSTRAINT "CHK_saga_execution_status"
      CHECK ("status" IN ('PENDENTE', 'EM_PROCESSAMENTO', 'CONCLUIDA', 'FALHA'))
    `);
  }
}
