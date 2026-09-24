import { MigrationInterface, QueryRunner } from 'typeorm';

export class VisitorConsent1710000000002 implements MigrationInterface {
  name = 'VisitorConsent1710000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE visitor_consents (
        id uuid PRIMARY KEY,
        "visitorHash" varchar NOT NULL,
        purpose varchar NOT NULL CHECK (purpose IN ('ANALYTICS','ADVERTISING')),
        "policyVersion" varchar NOT NULL,
        decision varchar NOT NULL CHECK (decision IN ('GRANTED','WITHDRAWN')),
        "recordedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX visitor_consents_latest_idx ON visitor_consents ("visitorHash", purpose, "recordedAt" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE visitor_consents');
  }
}
