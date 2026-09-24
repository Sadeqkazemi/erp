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
  SessionEntity,
  WorkflowRunEntity,
  VisitorConsentEntity,
} from './entities';
import { PlatformCoreFoundation1710000000000 } from './migrations/1710000000000-PlatformCoreFoundation';
import { PlatformCoreHardening1710000000001 } from './migrations/1710000000001-PlatformCoreHardening';
import { VisitorConsent1710000000002 } from './migrations/1710000000002-VisitorConsent';

export const coreEntities = [
  PrincipalEntity,
  SessionEntity,
  PanelEntity,
  EntitlementEntity,
  RouteContractEntity,
  WorkflowRunEntity,
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
    migrations: [PlatformCoreFoundation1710000000000, PlatformCoreHardening1710000000001, VisitorConsent1710000000002],
    synchronize: false,
  });
}
