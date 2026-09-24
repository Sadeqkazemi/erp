import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxRecovery1710000000005 implements MigrationInterface {
  name = 'OutboxRecovery1710000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE outbox_events
        ADD COLUMN "nextAttemptAt" timestamptz,
        ADD COLUMN "deadLetterAt" timestamptz;
      CREATE INDEX outbox_events_retry_idx ON outbox_events ("nextAttemptAt", "createdAt")
        WHERE "publishedAt" IS NULL AND "deadLetterAt" IS NULL;
      CREATE INDEX outbox_events_dead_idx ON outbox_events ("deadLetterAt" DESC)
        WHERE "deadLetterAt" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS outbox_events_dead_idx;
      DROP INDEX IF EXISTS outbox_events_retry_idx;
      ALTER TABLE outbox_events DROP COLUMN "deadLetterAt", DROP COLUMN "nextAttemptAt";
    `);
  }
}
