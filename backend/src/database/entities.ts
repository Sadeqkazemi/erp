import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'principals' })
@Index(['realm', 'username'], { unique: true })
export class PrincipalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  realm!: 'STAFF' | 'CUSTOMER' | 'AGENCY' | 'WORKLOAD';

  @Column({ type: 'varchar' })
  username!: string;

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

@Entity({ name: 'audit_events' })
export class AuditEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actorPrincipalId!: string | null;

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
