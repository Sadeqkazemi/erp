import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowCallbacks1710000000009 implements MigrationInterface {
  name = 'WorkflowCallbacks1710000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE workflow_step_callbacks (
      id uuid PRIMARY KEY,
      "workflowRunId" uuid NOT NULL REFERENCES workflow_runs(id),
      "workflowStepId" uuid NOT NULL REFERENCES workflow_steps(id),
      "reportedByPrincipalId" uuid NOT NULL REFERENCES principals(id),
      result varchar NOT NULL,
      "evidenceId" varchar NOT NULL,
      "occurredAt" timestamptz NOT NULL,
      "idempotencyKey" varchar NOT NULL,
      "receivedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflow_step_callbacks_result_chk CHECK (result IN ('SUCCEEDED','FAILED','COMPENSATED')),
      CONSTRAINT workflow_step_callbacks_idempotency_uq UNIQUE
        ("reportedByPrincipalId", "workflowRunId", "workflowStepId", "idempotencyKey")
    );
    CREATE INDEX workflow_step_callbacks_step_time_idx ON workflow_step_callbacks ("workflowStepId", "receivedAt" DESC);
    CREATE FUNCTION workflow_step_callbacks_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'workflow_step_callbacks is append-only'; END;
    $$;
    CREATE TRIGGER workflow_step_callbacks_no_update_delete BEFORE UPDATE OR DELETE ON workflow_step_callbacks
      FOR EACH ROW EXECUTE FUNCTION workflow_step_callbacks_append_only();
    CREATE TRIGGER workflow_step_callbacks_no_truncate BEFORE TRUNCATE ON workflow_step_callbacks
      FOR EACH STATEMENT EXECUTE FUNCTION workflow_step_callbacks_append_only();`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS workflow_step_callbacks_no_truncate ON workflow_step_callbacks;
      DROP TRIGGER IF EXISTS workflow_step_callbacks_no_update_delete ON workflow_step_callbacks;
      DROP FUNCTION IF EXISTS workflow_step_callbacks_append_only();
      DROP TABLE workflow_step_callbacks;`);
  }
}
