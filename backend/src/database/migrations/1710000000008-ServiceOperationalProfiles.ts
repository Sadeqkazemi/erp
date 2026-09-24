import { MigrationInterface, QueryRunner } from 'typeorm';

export class ServiceOperationalProfiles1710000000008 implements MigrationInterface {
  name = 'ServiceOperationalProfiles1710000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE service_operational_profiles (
      id uuid PRIMARY KEY,
      "ownerService" varchar NOT NULL,
      version integer NOT NULL,
      "ownerTeam" varchar NOT NULL,
      "onCallRoute" varchar NOT NULL,
      "runbookUrl" varchar NOT NULL,
      "availabilityTargetBps" integer NOT NULL,
      "latencyP95TargetMs" integer NOT NULL,
      "rtoMinutes" integer NOT NULL,
      "rpoMinutes" integer NOT NULL,
      "recordedByPrincipalId" uuid NOT NULL REFERENCES principals(id),
      "recordedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT service_operational_profiles_owner_version_uq UNIQUE ("ownerService", version),
      CONSTRAINT service_operational_profiles_owner_chk CHECK ("ownerService" ~ '^[a-z][a-z0-9-]{1,62}$'),
      CONSTRAINT service_operational_profiles_version_chk CHECK (version > 0),
      CONSTRAINT service_operational_profiles_availability_chk CHECK ("availabilityTargetBps" BETWEEN 1 AND 10000),
      CONSTRAINT service_operational_profiles_latency_chk CHECK ("latencyP95TargetMs" BETWEEN 1 AND 300000),
      CONSTRAINT service_operational_profiles_rto_chk CHECK ("rtoMinutes" BETWEEN 1 AND 525600),
      CONSTRAINT service_operational_profiles_rpo_chk CHECK ("rpoMinutes" BETWEEN 0 AND 525600)
    );
    CREATE INDEX service_operational_profiles_latest_idx
      ON service_operational_profiles ("ownerService", version DESC);
    CREATE FUNCTION service_operational_profiles_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'service_operational_profiles is append-only'; END;
    $$;
    CREATE TRIGGER service_operational_profiles_no_update_delete
      BEFORE UPDATE OR DELETE ON service_operational_profiles
      FOR EACH ROW EXECUTE FUNCTION service_operational_profiles_append_only();
    CREATE TRIGGER service_operational_profiles_no_truncate
      BEFORE TRUNCATE ON service_operational_profiles
      FOR EACH STATEMENT EXECUTE FUNCTION service_operational_profiles_append_only();`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS service_operational_profiles_no_truncate ON service_operational_profiles;
      DROP TRIGGER IF EXISTS service_operational_profiles_no_update_delete ON service_operational_profiles;
      DROP FUNCTION IF EXISTS service_operational_profiles_append_only();
      DROP TABLE service_operational_profiles;`);
  }
}
