import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowDefinitions1710000000006 implements MigrationInterface {
  name = 'WorkflowDefinitions1710000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE workflow_definitions (
      id uuid PRIMARY KEY,
      "definitionKey" varchar NOT NULL UNIQUE,
      "ownerService" varchar NOT NULL,
      steps jsonb NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflow_definitions_steps_array CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 32)
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE workflow_definitions');
  }
}
