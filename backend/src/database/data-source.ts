import { DataSource } from 'typeorm';
import {
  AuditEventEntity,
  ConsentRecordEntity,
  EntitlementEntity,
  IdempotencyRecordEntity,
  OutboxEventEntity,
  PanelEntity,
  PrincipalEntity,
  RouteContractEntity,
  ServiceObservationEntity,
  ServiceOperationalProfileEntity,
  SessionEntity,
  WorkflowRunEntity,
  WorkflowDefinitionEntity,
  WorkflowStepEntity,
  WorkflowStepCallbackEntity,
  VisitorConsentEntity,
} from './entities';
import { PlatformCoreFoundation1710000000000 } from './migrations/1710000000000-PlatformCoreFoundation';
import { PlatformCoreHardening1710000000001 } from './migrations/1710000000001-PlatformCoreHardening';
import { VisitorConsent1710000000002 } from './migrations/1710000000002-VisitorConsent';
import { AgencyTenant1710000000003 } from './migrations/1710000000003-AgencyTenant';
import { WorkflowSteps1710000000004 } from './migrations/1710000000004-WorkflowSteps';
import { OutboxRecovery1710000000005 } from './migrations/1710000000005-OutboxRecovery';
import { WorkflowDefinitions1710000000006 } from './migrations/1710000000006-WorkflowDefinitions';
import { ServiceObservations1710000000007 } from './migrations/1710000000007-ServiceObservations';
import { ServiceOperationalProfiles1710000000008 } from './migrations/1710000000008-ServiceOperationalProfiles';
import { WorkflowCallbacks1710000000009 } from './migrations/1710000000009-WorkflowCallbacks';
import { RouteTenantPolicy1710000000010 } from './migrations/1710000000010-RouteTenantPolicy';

export const coreEntities = [
  PrincipalEntity,
  SessionEntity,
  PanelEntity,
  EntitlementEntity,
  RouteContractEntity,
  ServiceObservationEntity,
  ServiceOperationalProfileEntity,
  WorkflowRunEntity,
  WorkflowDefinitionEntity,
  WorkflowStepEntity,
  WorkflowStepCallbackEntity,
  AuditEventEntity,
  OutboxEventEntity,
  ConsentRecordEntity,
  IdempotencyRecordEntity,
  VisitorConsentEntity,
];

export function createDataSource(databaseUrl = process.env.DATABASE_URL): DataSource {
  if (!databaseUrl) {
    throw new Error('Missing database URL: set DATABASE_URL (runtime) or DATABASE_MIGRATION_URL (migrations)');
  }
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: coreEntities,
    migrations: [PlatformCoreFoundation1710000000000, PlatformCoreHardening1710000000001, VisitorConsent1710000000002, AgencyTenant1710000000003, WorkflowSteps1710000000004, OutboxRecovery1710000000005, WorkflowDefinitions1710000000006, ServiceObservations1710000000007, ServiceOperationalProfiles1710000000008, WorkflowCallbacks1710000000009, RouteTenantPolicy1710000000010],
    synchronize: false,
  });
}
