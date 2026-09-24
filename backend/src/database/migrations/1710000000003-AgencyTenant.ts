import { MigrationInterface, QueryRunner } from 'typeorm';

export class AgencyTenant1710000000003 implements MigrationInterface {
  name = 'AgencyTenant1710000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE principals ADD COLUMN "tenantId" uuid;
      ALTER TABLE audit_events ADD COLUMN "tenantId" uuid;
      ALTER TABLE principals DROP CONSTRAINT principals_realm_username_uq;
      CREATE UNIQUE INDEX principals_nonagency_username_uq ON principals (realm, username) WHERE realm <> 'AGENCY';
      CREATE UNIQUE INDEX principals_agency_tenant_username_uq ON principals ("tenantId", username) WHERE realm = 'AGENCY';
      ALTER TABLE principals ADD CONSTRAINT principals_agency_tenant_chk
        CHECK ((realm = 'AGENCY' AND "tenantId" IS NOT NULL) OR (realm <> 'AGENCY' AND "tenantId" IS NULL)) NOT VALID;
      CREATE INDEX audit_events_tenant_created_idx ON audit_events ("tenantId", "createdAt" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX audit_events_tenant_created_idx;
      ALTER TABLE principals DROP CONSTRAINT principals_agency_tenant_chk;
      DROP INDEX principals_agency_tenant_username_uq;
      DROP INDEX principals_nonagency_username_uq;
      ALTER TABLE principals ADD CONSTRAINT principals_realm_username_uq UNIQUE (realm, username);
      ALTER TABLE audit_events DROP COLUMN "tenantId";
      ALTER TABLE principals DROP COLUMN "tenantId";
    `);
  }
}
