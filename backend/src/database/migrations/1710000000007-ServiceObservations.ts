import { MigrationInterface, QueryRunner } from 'typeorm';

export class ServiceObservations1710000000007 implements MigrationInterface {
  name = 'ServiceObservations1710000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE service_observations (
      id uuid PRIMARY KEY,
      "routeId" uuid NOT NULL REFERENCES route_contracts(id),
      status varchar NOT NULL,
      "httpStatus" integer,
      "latencyMs" integer NOT NULL,
      "errorCode" varchar,
      source varchar NOT NULL,
      "observedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT service_observations_status_chk CHECK (status IN ('UP','DOWN')),
      CONSTRAINT service_observations_source_chk CHECK (source = 'MANUAL_PROBE'),
      CONSTRAINT service_observations_latency_chk CHECK ("latencyMs" BETWEEN 0 AND 300000),
      CONSTRAINT service_observations_http_chk CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599)
    );
    CREATE INDEX service_observations_route_time_idx ON service_observations ("routeId", "observedAt" DESC);
    CREATE FUNCTION service_observations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'service_observations is append-only'; END;
    $$;
    CREATE TRIGGER service_observations_no_update_delete BEFORE UPDATE OR DELETE ON service_observations
      FOR EACH ROW EXECUTE FUNCTION service_observations_append_only();
    CREATE TRIGGER service_observations_no_truncate BEFORE TRUNCATE ON service_observations
      FOR EACH STATEMENT EXECUTE FUNCTION service_observations_append_only();`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS service_observations_no_truncate ON service_observations;
      DROP TRIGGER IF EXISTS service_observations_no_update_delete ON service_observations;
      DROP FUNCTION IF EXISTS service_observations_append_only();
      DROP TABLE service_observations;`);
  }
}
