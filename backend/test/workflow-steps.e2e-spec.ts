import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CoreEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { PrincipalEntity, WorkflowRunEntity, WorkflowStepEntity } from '../src/database/entities';
import { AuthenticatedPrincipal, PlatformCoreService } from '../src/modules/platform-core.service';

const databaseUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('durable workflow steps and deadline recovery', () => {
  let db: DataSource;
  let core: PlatformCoreService;
  let actor: AuthenticatedPrincipal;

  beforeAll(async () => {
    db = createDataSource(databaseUrl);
    await db.initialize();
    const id = randomUUID();
    await db.getRepository(PrincipalEntity).save({
      id, realm: 'STAFF', username: `workflow-${id}`, tenantId: null, passwordHash: 'test-fixture',
      role: 'MEMBER', status: 'ACTIVE', mfaSecretCiphertext: null, lastTotpStep: null,
    });
    actor = { id, realm: 'STAFF', username: `workflow-${id}`, role: 'MEMBER', tenantId: null, sessionId: randomUUID(), csrfToken: '' };
    core = new PlatformCoreService(db, {} as CoreEnv);
  });

  afterAll(async () => { await db?.destroy(); });

  async function startedRun() {
    const run = await core.startWorkflow(actor, {
      definitionKey: 'operations.recovery.v1', ownerService: 'operations', correlationId: randomUUID(),
    }, randomUUID());
    await core.transitionWorkflow(actor, run.id, 'RUNNING', randomUUID());
    return run.id;
  }

  it('blocks completion with an unfinished step and fails an expired step exactly once', async () => {
    const runId = await startedRun();
    await core.createWorkflowStep(actor, runId, { stepKey: 'reserve-resource', timeoutSeconds: 60 }, randomUUID(), randomUUID());
    await expect(core.transitionWorkflow(actor, runId, 'COMPLETED', randomUUID())).rejects.toMatchObject({ status: 409 });
    await db.query('UPDATE workflow_steps SET "deadlineAt" = now() - interval \'1 second\' WHERE "workflowRunId" = $1', [runId]);
    expect(await core.expireWorkflowSteps()).toBe(1);
    expect(await core.expireWorkflowSteps()).toBe(0);
    const run = await db.getRepository(WorkflowRunEntity).findOneByOrFail({ id: runId });
    const step = await db.getRepository(WorkflowStepEntity).findOneByOrFail({ workflowRunId: runId });
    expect(run.status).toBe('FAILED');
    expect(step.status).toBe('FAILED');
  });

  it('requires compensation of successful steps when a later step times out', async () => {
    const runId = await startedRun();
    await core.createWorkflowStep(actor, runId, { stepKey: 'hold-seat', timeoutSeconds: 60 }, randomUUID(), randomUUID());
    await core.transitionWorkflowStep(actor, runId, 'hold-seat', 'RUNNING', randomUUID());
    await core.transitionWorkflowStep(actor, runId, 'hold-seat', 'SUCCEEDED', randomUUID());
    await core.createWorkflowStep(actor, runId, { stepKey: 'collect-funds', timeoutSeconds: 60 }, randomUUID(), randomUUID());
    await db.query('UPDATE workflow_steps SET "deadlineAt" = now() - interval \'1 second\' WHERE "workflowRunId" = $1 AND "stepKey" = $2', [runId, 'collect-funds']);
    expect(await core.expireWorkflowSteps()).toBe(1);
    const run = await db.getRepository(WorkflowRunEntity).findOneByOrFail({ id: runId });
    expect(run.status).toBe('COMPENSATING');
    await expect(core.transitionWorkflow(actor, runId, 'COMPENSATED', randomUUID())).rejects.toMatchObject({ status: 409 });
    await core.transitionWorkflowStep(actor, runId, 'hold-seat', 'COMPENSATING', randomUUID());
    await core.transitionWorkflowStep(actor, runId, 'hold-seat', 'COMPENSATED', randomUUID());
    await expect(core.transitionWorkflow(actor, runId, 'COMPENSATED', randomUUID())).resolves.toMatchObject({ status: 'COMPENSATED' });
  });
});
