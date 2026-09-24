import 'reflect-metadata';
import { DataSource, EntityManager } from 'typeorm';
import { CoreEnv } from '../config/env';
import { IdempotencyRecordEntity, WorkflowDefinitionEntity, WorkflowRunEntity } from '../database/entities';
import { AuthenticatedPrincipal, PlatformCoreService } from './platform-core.service';

describe('registered workflow contracts', () => {
  const actor = { id: '11111111-1111-4111-8111-111111111111', realm: 'STAFF', role: 'MEMBER' } as AuthenticatedPrincipal;
  const run = { id: '22222222-2222-4222-8222-222222222222', definitionKey: 'ops.recovery.v1', status: 'RUNNING', startedByPrincipalId: actor.id };
  const definition = { definitionKey: run.definitionKey, ownerService: 'ops', steps: [{ stepKey: 'notify-crew', timeoutSeconds: 120 }] };
  let current: typeof definition | null;
  const manager = {
    query: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(async (entity: unknown) => entity === WorkflowRunEntity ? run : entity === WorkflowDefinitionEntity ? current : entity === IdempotencyRecordEntity ? null : null),
  } as unknown as EntityManager;
  const db = { transaction: jest.fn(async (fn: (em: EntityManager) => Promise<unknown>) => fn(manager)) } as unknown as DataSource;
  const core = new PlatformCoreService(db, { workflowDefinitionsRequired: true } as CoreEnv);

  beforeEach(() => { current = null; });

  it('refuses a run when the contract is absent in production mode', async () => {
    await expect(core.startWorkflow(actor, { definitionKey: run.definitionKey, ownerService: 'ops', correlationId: 'corr' }, 'unique-key-1'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('refuses another owner and any unregistered step or timeout', async () => {
    current = definition;
    await expect(core.startWorkflow(actor, { definitionKey: run.definitionKey, ownerService: 'other', correlationId: 'corr' }, 'unique-key-2'))
      .rejects.toMatchObject({ status: 403 });
    await expect(core.createWorkflowStep(actor, run.id, { stepKey: 'notify-crew', timeoutSeconds: 300 }, 'unique-key-3', 'corr'))
      .rejects.toMatchObject({ status: 403 });
    await expect(core.createWorkflowStep(actor, run.id, { stepKey: 'charge-card', timeoutSeconds: 120 }, 'unique-key-4', 'corr'))
      .rejects.toMatchObject({ status: 403 });
  });

  it('rejects duplicate keys in a definition before writing', async () => {
    const admin = { ...actor, role: 'PLATFORM_ADMIN' } as AuthenticatedPrincipal;
    await expect(core.registerWorkflowDefinition(admin, {
      definitionKey: run.definitionKey, ownerService: 'ops', steps: [definition.steps[0], definition.steps[0]],
    }, 'corr')).rejects.toMatchObject({ status: 400 });
  });
});
