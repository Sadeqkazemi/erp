import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'principals' })
export class PrincipalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  realm!: 'STAFF' | 'CUSTOMER' | 'AGENCY' | 'WORKLOAD';

  @Column({ type: 'varchar' })
  username!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar' })
  passwordHash!: string;

  @Column({ type: 'varchar', nullable: true })
  mfaSecretCiphertext!: string | null;

  @Column({ type: 'varchar' })
  role!: 'PLATFORM_ADMIN' | 'MEMBER';

  @Column({ type: 'varchar', default: 'ACTIVE' })
  status!: 'ACTIVE' | 'DISABLED';

  @Column({ type: 'bigint', nullable: true })
  lastTotpStep!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'sessions' })
export class SessionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  principalId!: string;

  @Column({ type: 'varchar', unique: true })
  tokenHash!: string;

  @Column({ type: 'varchar' })
  csrfHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  replacedBySessionId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'panels' })
export class PanelEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  code!: string;

  @Column({ type: 'varchar' })
  ownerService!: string;

  @Column({ type: 'varchar' })
  classification!: string;

  @Column({ type: 'varchar' })
  titleFa!: string;

  @Column({ type: 'varchar' })
  titleEn!: string;

  @Column({ type: 'varchar' })
  audience!: string;

  @Column({ type: 'varchar', default: 'ACTIVE' })
  status!: 'ACTIVE' | 'DISABLED';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'entitlements' })
@Index(['principalId', 'panelId'], { unique: true })
export class EntitlementEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  principalId!: string;

  @Column('uuid')
  panelId!: string;

  @Column('uuid')
  grantedByPrincipalId!: string;

  @Column({ type: 'varchar' })
  status!: 'ACTIVE' | 'REVOKED';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'route_contracts' })
@Index(['method', 'pathPattern', 'version'], { unique: true })
export class RouteContractEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  method!: string;

  @Column({ type: 'varchar' })
  pathPattern!: string;

  @Column({ type: 'varchar' })
  upstreamBaseUrl!: string;

  @Column({ type: 'varchar' })
  audience!: string;

  @Column({ type: 'int' })
  timeoutMs!: number;

  @Column({ type: 'varchar' })
  allowedRealms!: string;

  @Column({ type: 'varchar' })
  version!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'service_observations' })
@Index(['routeId', 'observedAt'])
export class ServiceObservationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  routeId!: string;

  @Column({ type: 'varchar' })
  status!: 'UP' | 'DOWN';

  @Column({ type: 'int', nullable: true })
  httpStatus!: number | null;

  @Column({ type: 'int' })
  latencyMs!: number;

  @Column({ type: 'varchar', nullable: true })
  errorCode!: string | null;

  @Column({ type: 'varchar' })
  source!: 'MANUAL_PROBE';

  @CreateDateColumn({ type: 'timestamptz' })
  observedAt!: Date;
}

@Entity({ name: 'service_operational_profiles' })
@Index(['ownerService', 'version'], { unique: true })
export class ServiceOperationalProfileEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  ownerService!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'varchar' })
  ownerTeam!: string;

  @Column({ type: 'varchar' })
  onCallRoute!: string;

  @Column({ type: 'varchar' })
  runbookUrl!: string;

  @Column({ type: 'int' })
  availabilityTargetBps!: number;

  @Column({ type: 'int' })
  latencyP95TargetMs!: number;

  @Column({ type: 'int' })
  rtoMinutes!: number;

  @Column({ type: 'int' })
  rpoMinutes!: number;

  @Column('uuid')
  recordedByPrincipalId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt!: Date;
}

export interface WorkflowDefinitionStep { stepKey: string; timeoutSeconds: number }

@Entity({ name: 'workflow_definitions' })
export class WorkflowDefinitionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  definitionKey!: string;

  @Column({ type: 'varchar' })
  ownerService!: string;

  @Column({ type: 'jsonb' })
  steps!: WorkflowDefinitionStep[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'workflow_runs' })
@Index(['startedByPrincipalId', 'idempotencyKey'], { unique: true })
export class WorkflowRunEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  definitionKey!: string;

  @Column({ type: 'varchar' })
  ownerService!: string;

  @Column({ type: 'varchar' })
  correlationId!: string;

  @Column({ type: 'varchar' })
  status!: 'PENDING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'COMPENSATING' | 'COMPENSATED';

  @Column({ type: 'int', default: 0 })
  attempt!: number;

  @Column({ type: 'varchar' })
  idempotencyKey!: string;

  @Column({ type: 'uuid', nullable: true })
  startedByPrincipalId!: string | null;

  @VersionColumn()
  version!: number;

  @Column({ type: 'timestamptz', nullable: true })
  nextTimerAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'workflow_steps' })
@Index(['workflowRunId', 'stepKey'], { unique: true })
export class WorkflowStepEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  workflowRunId!: string;

  @Column({ type: 'varchar' })
  stepKey!: string;

  @Column({ type: 'varchar' })
  status!: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'COMPENSATING' | 'COMPENSATED';

  @Column({ type: 'int', default: 0 })
  attempt!: number;

  @Column({ type: 'timestamptz' })
  deadlineAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'audit_events' })
export class AuditEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actorPrincipalId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'varchar' })
  objectType!: string;

  @Column({ type: 'varchar' })
  objectId!: string;

  @Column({ type: 'varchar' })
  correlationId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  eventId!: string;

  @Column({ type: 'varchar' })
  eventName!: string;

  @Column({ type: 'varchar' })
  aggregateId!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, string>;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deadLetterAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'consent_records' })
export class ConsentRecordEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  principalId!: string;

  @Column({ type: 'varchar' })
  purpose!: 'ANALYTICS' | 'ADVERTISING';

  @Column({ type: 'varchar' })
  policyVersion!: string;

  @Column({ type: 'varchar' })
  decision!: 'GRANTED' | 'WITHDRAWN';

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt!: Date;
}

@Entity({ name: 'visitor_consents' })
export class VisitorConsentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  visitorHash!: string;

  @Column({ type: 'varchar' })
  purpose!: 'ANALYTICS' | 'ADVERTISING';

  @Column({ type: 'varchar' })
  policyVersion!: string;

  @Column({ type: 'varchar' })
  decision!: 'GRANTED' | 'WITHDRAWN';

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt!: Date;
}

@Entity({ name: 'idempotency_records' })
@Index(['principalId', 'scope', 'key'], { unique: true })
export class IdempotencyRecordEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  principalId!: string | null;

  @Column({ type: 'varchar' })
  scope!: string;

  @Column({ type: 'varchar' })
  key!: string;

  @Column({ type: 'varchar' })
  requestHash!: string;

  @Column({ type: 'jsonb' })
  responseJson!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
