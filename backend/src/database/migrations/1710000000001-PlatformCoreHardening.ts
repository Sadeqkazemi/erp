import { MigrationInterface, QueryRunner } from 'typeorm';

export class PlatformCoreHardening1710000000001 implements MigrationInterface {
  name = 'PlatformCoreHardening1710000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE principals ADD COLUMN "lastTotpStep" bigint;

      ALTER TABLE panels
        ADD CONSTRAINT panels_status_chk CHECK (status IN ('ACTIVE','DISABLED')),
        ADD CONSTRAINT panels_code_chk CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$');

      ALTER TABLE route_contracts
        ADD CONSTRAINT route_contracts_method_chk CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),
        ADD CONSTRAINT route_contracts_timeout_chk CHECK ("timeoutMs" BETWEEN 50 AND 5000);

      ALTER TABLE workflow_runs
        ADD COLUMN "startedByPrincipalId" uuid REFERENCES principals(id),
        ADD COLUMN version integer NOT NULL DEFAULT 1,
        ADD CONSTRAINT workflow_runs_status_chk
          CHECK (status IN ('PENDING','RUNNING','WAITING','COMPLETED','FAILED','COMPENSATING','COMPENSATED'));
      ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS "workflow_runs_idempotencyKey_key";
      CREATE UNIQUE INDEX workflow_runs_starter_idempotency_uq
        ON workflow_runs ("startedByPrincipalId", "idempotencyKey");

      ALTER TABLE idempotency_records
        ADD COLUMN "principalId" uuid,
        ADD COLUMN scope varchar NOT NULL DEFAULT 'legacy';
      ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_pkey;
      ALTER TABLE idempotency_records ADD COLUMN id uuid;
      UPDATE idempotency_records SET id = md5(random()::text || key)::uuid;
      ALTER TABLE idempotency_records ALTER COLUMN id SET NOT NULL;
      ALTER TABLE idempotency_records ADD PRIMARY KEY (id);
      CREATE UNIQUE INDEX idempotency_records_owner_scope_key_uq
        ON idempotency_records ("principalId", scope, key);

      ALTER TABLE outbox_events
        ADD COLUMN attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN "lastError" varchar;
      CREATE INDEX outbox_events_pending_idx ON outbox_events ("createdAt") WHERE "publishedAt" IS NULL;

      CREATE INDEX audit_events_created_idx ON audit_events ("createdAt" DESC);
      CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only';
      END;
      $$;
      CREATE TRIGGER audit_events_no_update_delete
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
      CREATE TRIGGER audit_events_no_truncate
        BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
      DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events;
      DROP FUNCTION IF EXISTS audit_events_append_only();
      DROP INDEX IF EXISTS audit_events_created_idx;
      DROP INDEX IF EXISTS outbox_events_pending_idx;
      ALTER TABLE outbox_events DROP COLUMN IF EXISTS "lastError", DROP COLUMN IF EXISTS attempts;
      DROP INDEX IF EXISTS idempotency_records_owner_scope_key_uq;
      ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_pkey;
      ALTER TABLE idempotency_records DROP COLUMN id;
      ALTER TABLE idempotency_records ADD PRIMARY KEY (key);
      ALTER TABLE idempotency_records DROP COLUMN scope, DROP COLUMN "principalId";
      DROP INDEX IF EXISTS workflow_runs_starter_idempotency_uq;
      ALTER TABLE workflow_runs ADD CONSTRAINT "workflow_runs_idempotencyKey_key" UNIQUE ("idempotencyKey");
      ALTER TABLE workflow_runs
        DROP CONSTRAINT workflow_runs_status_chk,
        DROP COLUMN version,
        DROP COLUMN "startedByPrincipalId";
      ALTER TABLE route_contracts DROP CONSTRAINT route_contracts_timeout_chk, DROP CONSTRAINT route_contracts_method_chk;
      ALTER TABLE panels DROP CONSTRAINT panels_code_chk, DROP CONSTRAINT panels_status_chk;
      ALTER TABLE principals DROP COLUMN "lastTotpStep";
    `);
  }
}
