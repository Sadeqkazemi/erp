import { MigrationInterface, QueryRunner } from 'typeorm';

export class RouteTenantPolicy1710000000010 implements MigrationInterface {
  name = 'RouteTenantPolicy1710000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX panels_audience_uq ON panels (audience);
      ALTER TABLE route_contracts ADD COLUMN "tenantPathParam" varchar;
      ALTER TABLE route_contracts ADD CONSTRAINT route_contracts_tenant_param_chk
        CHECK ("tenantPathParam" IS NULL OR "tenantPathParam" ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$');`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE route_contracts DROP CONSTRAINT route_contracts_tenant_param_chk;
      ALTER TABLE route_contracts DROP COLUMN "tenantPathParam";`);
    await queryRunner.query('DROP INDEX panels_audience_uq;');
  }
}
