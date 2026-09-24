import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowSteps1710000000004 implements MigrationInterface {
  name = 'WorkflowSteps1710000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE workflow_steps (
        id uuid PRIMARY KEY,
        "workflowRunId" uuid NOT NULL REFERENCES workflow_runs(id),
        "stepKey" varchar NOT NULL,
        status varchar NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','COMPENSATING','COMPENSATED')),
        attempt integer NOT NULL DEFAULT 0,
        "deadlineAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT workflow_steps_run_key_uq UNIQUE ("workflowRunId", "stepKey")
      );
      CREATE INDEX workflow_steps_due_idx ON workflow_steps ("deadlineAt") WHERE status IN ('PENDING','RUNNING');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE workflow_steps');
  }
}
