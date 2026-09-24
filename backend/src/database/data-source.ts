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
} from './entities';
import { PlatformCoreFoundation1710000000000 } from './migrations/1710000000000-PlatformCoreFoundation';

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
];

export function createDataSource(databaseUrl = process.env.DATABASE_URL): DataSource {
  if (!databaseUrl) {
    throw new Error('Missing required environment variable DATABASE_URL');
  }
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: coreEntities,
    migrations: [PlatformCoreFoundation1710000000000],
    synchronize: false,
  });
}
