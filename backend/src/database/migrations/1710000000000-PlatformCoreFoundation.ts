import { MigrationInterface, QueryRunner } from 'typeorm';

export class PlatformCoreFoundation1710000000000 implements MigrationInterface {
  name = 'PlatformCoreFoundation1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE principals (
        id uuid PRIMARY KEY,
        realm varchar NOT NULL,
        username varchar NOT NULL,
        "passwordHash" varchar NOT NULL,
        "mfaSecretCiphertext" varchar,
        role varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'ACTIVE',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT principals_realm_chk CHECK (realm IN ('STAFF','CUSTOMER','AGENCY','WORKLOAD')),
        CONSTRAINT principals_role_chk CHECK (role IN ('PLATFORM_ADMIN','MEMBER')),
        CONSTRAINT principals_status_chk CHECK (status IN ('ACTIVE','DISABLED')),
        CONSTRAINT principals_realm_username_uq UNIQUE (realm, username)
      );
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        "principalId" uuid NOT NULL REFERENCES principals(id),
        "tokenHash" varchar NOT NULL UNIQUE,
        "csrfHash" varchar NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz,
        "replacedBySessionId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE panels (
        id uuid PRIMARY KEY,
        code varchar NOT NULL UNIQUE,
        "ownerService" varchar NOT NULL,
        classification varchar NOT NULL,
        "titleFa" varchar NOT NULL,
        "titleEn" varchar NOT NULL,
        audience varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'ACTIVE',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE entitlements (
        id uuid PRIMARY KEY,
        "principalId" uuid NOT NULL REFERENCES principals(id),
        "panelId" uuid NOT NULL REFERENCES panels(id),
        "grantedByPrincipalId" uuid NOT NULL REFERENCES principals(id),
        status varchar NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT entitlements_status_chk CHECK (status IN ('ACTIVE','REVOKED')),
        CONSTRAINT entitlements_principal_panel_uq UNIQUE ("principalId", "panelId")
      );
      CREATE TABLE route_contracts (
        id uuid PRIMARY KEY,
        method varchar NOT NULL,
        "pathPattern" varchar NOT NULL,
        "upstreamBaseUrl" varchar NOT NULL,
        audience varchar NOT NULL,
        "timeoutMs" integer NOT NULL,
        "allowedRealms" varchar NOT NULL,
        version varchar NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT route_contracts_uq UNIQUE (method, "pathPattern", version)
      );
      CREATE TABLE workflow_runs (
        id uuid PRIMARY KEY,
        "definitionKey" varchar NOT NULL,
        "ownerService" varchar NOT NULL,
        "correlationId" varchar NOT NULL,
        status varchar NOT NULL,
        attempt integer NOT NULL DEFAULT 0,
        "idempotencyKey" varchar NOT NULL UNIQUE,
        "nextTimerAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE audit_events (
        id uuid PRIMARY KEY,
        "actorPrincipalId" uuid,
        action varchar NOT NULL,
        "objectType" varchar NOT NULL,
        "objectId" varchar NOT NULL,
        "correlationId" varchar NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY,
        "eventId" uuid NOT NULL UNIQUE,
        "eventName" varchar NOT NULL,
        "aggregateId" varchar NOT NULL,
        payload jsonb NOT NULL,
        "publishedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE consent_records (
        id uuid PRIMARY KEY,
        "principalId" uuid NOT NULL REFERENCES principals(id),
        purpose varchar NOT NULL,
        "policyVersion" varchar NOT NULL,
        decision varchar NOT NULL,
        "recordedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT consent_purpose_chk CHECK (purpose IN ('ANALYTICS','ADVERTISING')),
        CONSTRAINT consent_decision_chk CHECK (decision IN ('GRANTED','WITHDRAWN'))
      );
      CREATE TABLE idempotency_records (
        key varchar PRIMARY KEY,
        "requestHash" varchar NOT NULL,
        "responseJson" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS idempotency_records;
      DROP TABLE IF EXISTS consent_records;
      DROP TABLE IF EXISTS outbox_events;
      DROP TABLE IF EXISTS audit_events;
      DROP TABLE IF EXISTS workflow_runs;
      DROP TABLE IF EXISTS route_contracts;
      DROP TABLE IF EXISTS entitlements;
      DROP TABLE IF EXISTS panels;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS principals;
    `);
  }
}
