import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { ErrorCode } from '../common/errors';
import {
  csrfCookieName,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  panelTokenJwks,
  randomToken,
  sessionCookieName,
  sessionCookiePolicy,
  sha256,
  signPanelToken,
  totpCode,
  verifyPanelToken,
  verifyTotp,
} from '../common/crypto';
import { CORE_ENV, CoreEnv } from '../config/env';
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
} from '../database/entities';
import { assertWorkflowTransition, WorkflowStatus } from './workflow/workflow-transitions';

export interface AuthenticatedPrincipal {
  id: string;
  realm: PrincipalEntity['realm'];
  username: string;
  role: PrincipalEntity['role'];
  sessionId: string;
  csrfToken: string;
}

const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const REALMS: PrincipalEntity['realm'][] = ['STAFF', 'CUSTOMER', 'AGENCY', 'WORKLOAD'];
const OUTBOX_BATCH = 100;

export interface RouteInput {
  method: string;
  pathPattern: string;
  upstreamBaseUrl: string;
  audience: string;
  timeoutMs: number;
  allowedRealms: string[];
  version: string;
}

export interface PublishedEvent {
  eventId: string;
  eventName: string;
  aggregateId: string;
  payload: Record<string, string>;
}

@Injectable()
export class PlatformCoreService {
  // Observability snapshot for tests; broker acceptance, not this list, determines delivery.
  private readonly acceptedEvents: PublishedEvent[] = [];
  private dummyPasswordHash: Promise<string> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(CORE_ENV) private readonly env: CoreEnv,
  ) {}

  cookieName(): string {
    return sessionCookieName(this.env.cookieSecure);
  }

  csrfName(): string {
    return csrfCookieName(this.env.cookieSecure);
  }

  sessionPolicy() {
    return sessionCookiePolicy(this.env.cookieSecure);
  }

  async createPrincipal(input: {
    realm: PrincipalEntity['realm'];
    username: string;
    password: string;
    role: PrincipalEntity['role'];
    totpSecret?: string;
  }): Promise<{ id: string; totpSecret: string | null }> {
    if (input.realm !== 'STAFF' && input.role === 'PLATFORM_ADMIN') {
      throw new ForbiddenException({
        code: ErrorCode.REALM_REJECTED,
        message: 'نقش مدیر سکو فقط برای کارکنان مجاز است.',
      });
    }
    const totpSecret = input.realm === 'STAFF' ? (input.totpSecret ?? generateTotpSecret()) : null;
    const principal = this.dataSource.getRepository(PrincipalEntity).create({
      id: randomUUID(),
      realm: input.realm,
      username: input.username,
      passwordHash: await argon2.hash(input.password, ARGON2_OPTIONS),
      mfaSecretCiphertext: totpSecret ? encryptSecret(totpSecret, this.env.mfaEncryptionKey) : null,
      role: input.role,
      status: 'ACTIVE',
    });
    await this.dataSource.getRepository(PrincipalEntity).save(principal);
    return { id: principal.id, totpSecret };
  }

  currentTotp(secret: string, at = new Date()): string {
    return totpCode(secret, at);
  }

  async login(input: {
    realm: PrincipalEntity['realm'];
    username: string;
    password: string;
    totp?: string;
  }): Promise<{ principal: AuthenticatedPrincipal; sessionToken: string; csrfToken: string }> {
    if (input.realm === 'WORKLOAD') {
      throw new ForbiddenException({
        code: ErrorCode.REALM_REJECTED,
        message: 'هویت سرویس با رمز عبور وارد نمی‌شود؛ از هویت کاری کوتاه‌عمر استفاده کنید.',
      });
    }
    const principal = await this.dataSource.getRepository(PrincipalEntity).findOne({
      where: { realm: input.realm, username: input.username, status: 'ACTIVE' },
    });
    const invalid = new UnauthorizedException({
      code: ErrorCode.INVALID_CREDENTIALS,
      message: 'نام کاربری یا رمز عبور نادرست است.',
    });
    // Verify against a dummy hash for unknown users so response time does not reveal which usernames exist.
    const passwordOk = await argon2.verify(principal?.passwordHash ?? (await this.dummyHash()), input.password);
    if (!principal || !passwordOk) {
      throw invalid;
    }
    if (principal.realm === 'STAFF') {
      if (!principal.mfaSecretCiphertext || !input.totp) {
        throw new UnauthorizedException({
          code: ErrorCode.INVALID_CREDENTIALS,
          message: 'کد تأیید دومرحله‌ای نادرست است.',
        });
      }
      const secret = decryptSecret(principal.mfaSecretCiphertext, this.env.mfaEncryptionKey);
      const step = verifyTotp(secret, input.totp, new Date());
      // Each TOTP step is accepted once; a replayed or older code is rejected atomically.
      const claimed = step === null
        ? 0
        : ((await this.dataSource.query(
            `UPDATE principals SET "lastTotpStep" = $1
             WHERE id = $2 AND ("lastTotpStep" IS NULL OR "lastTotpStep" < $1)
             RETURNING id`,
            [step, principal.id],
          )) as [unknown[], number])[1];
      if (!claimed) {
        throw new UnauthorizedException({
          code: ErrorCode.INVALID_CREDENTIALS,
          message: 'کد تأیید دومرحله‌ای نادرست است.',
        });
      }
    }
    return this.openSession(principal.id);
  }

  async authenticate(sessionToken: string): Promise<AuthenticatedPrincipal> {
    const session = await this.dataSource.getRepository(SessionEntity).findOne({
      where: { tokenHash: sha256(sessionToken) },
    });
    if (!session || session.revokedAt) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'نشست معتبر نیست.',
      });
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: ErrorCode.SESSION_EXPIRED,
        message: 'نشست منقضی شده است.',
      });
    }
    const principal = await this.requirePrincipal(session.principalId);
    if (principal.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'نشست معتبر نیست.',
      });
    }
    return {
      id: principal.id,
      realm: principal.realm,
      username: principal.username,
      role: principal.role,
      sessionId: session.id,
      csrfToken: '',
    };
  }

  async assertCsrf(sessionToken: string, presented: string | undefined): Promise<void> {
    if (!presented) {
      throw new ForbiddenException({
        code: ErrorCode.CSRF_REJECTED,
        message: 'درخواست بدون نشانه CSRF رد شد.',
      });
    }
    const session = await this.dataSource.getRepository(SessionEntity).findOne({
      where: { tokenHash: sha256(sessionToken) },
    });
    if (!session || session.csrfHash !== sha256(presented)) {
      throw new ForbiddenException({
        code: ErrorCode.CSRF_REJECTED,
        message: 'درخواست بدون نشانه CSRF رد شد.',
      });
    }
  }

  async logout(sessionToken: string, actorId: string, correlationId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(SessionEntity, { where: { tokenHash: sha256(sessionToken) } });
      if (!session || session.revokedAt) {
        return;
      }
      session.revokedAt = new Date();
      await manager.save(session);
      await this.appendControl(manager, {
        actorId,
        action: 'session.revoked',
        objectType: 'session',
        objectId: session.id,
        correlationId,
        eventName: 'identity.session.revoked.v1',
        payload: { sessionId: session.id },
      });
    });
  }

  async rotate(sessionToken: string, actorId: string, correlationId: string): Promise<{ sessionToken: string; csrfToken: string }> {
    return this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(SessionEntity, { where: { tokenHash: sha256(sessionToken) } });
      if (!current || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException({
          code: ErrorCode.UNAUTHENTICATED,
          message: 'نشست معتبر نیست.',
        });
      }
      const opened = await this.insertSession(manager, current.principalId);
      current.revokedAt = new Date();
      current.replacedBySessionId = opened.sessionId;
      await manager.save(current);
      await this.appendControl(manager, {
        actorId,
        action: 'session.rotated',
        objectType: 'session',
        objectId: opened.sessionId,
        correlationId,
        eventName: 'identity.session.rotated.v1',
        payload: { sessionId: opened.sessionId },
      });
      return { sessionToken: opened.sessionToken, csrfToken: opened.csrfToken };
    });
  }

  async registerPanel(
    actor: AuthenticatedPrincipal,
    input: {
      code: string;
      ownerService: string;
      classification: string;
      titleFa: string;
      titleEn: string;
      audience: string;
    },
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ id: string; code: string; audience: string }> {
    this.requirePlatformAdmin(actor);
    return this.dataSource.transaction(async (manager) =>
      this.idempotent(manager, actor.id, 'panel.register', idempotencyKey, input, async () => {
        const clash = await manager.findOne(PanelEntity, { where: { code: input.code } });
        if (clash) {
          throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'پنلی با این کد از قبل ثبت شده است.' });
        }
        const panel = manager.create(PanelEntity, {
          id: randomUUID(),
          ...input,
          status: 'ACTIVE' as const,
        });
        await manager.save(panel);
        await this.appendControl(manager, {
          actorId: actor.id,
          action: 'panel.registered',
          objectType: 'panel',
          objectId: panel.id,
          correlationId,
          eventName: 'core.panel.registered.v1',
          payload: { panelId: panel.id, code: panel.code, audience: panel.audience },
        });
        return { id: panel.id, code: panel.code, audience: panel.audience };
      }),
    );
  }

  async listEntitledPanels(actor: AuthenticatedPrincipal): Promise<PanelEntity[]> {
    const entitlements = await this.dataSource.getRepository(EntitlementEntity).find({
      where: { principalId: actor.id, status: 'ACTIVE' },
    });
    if (entitlements.length === 0) {
      return [];
    }
    return this.dataSource.getRepository(PanelEntity).find({
      where: { id: In(entitlements.map((row) => row.panelId)), status: 'ACTIVE' },
    });
  }

  async grantEntitlement(
    actor: AuthenticatedPrincipal,
    input: { principalId: string; panelCode: string },
    correlationId: string,
  ): Promise<EntitlementEntity> {
    this.requirePlatformAdmin(actor);
    if (actor.id === input.principalId) {
      throw new ForbiddenException({
        code: ErrorCode.SELF_GRANT_FORBIDDEN,
        message: 'مدیر نمی‌تواند برای خودش دسترسی پنل صادر کند.',
      });
    }
    const target = await this.requirePrincipal(input.principalId);
    if (target.realm !== 'STAFF') {
      throw new ForbiddenException({
        code: ErrorCode.REALM_REJECTED,
        message: 'دسترسی پنل کارکنان به هویت مشتری یا آژانس داده نمی‌شود.',
      });
    }
    return this.dataSource.transaction(async (manager) => {
      const panel = await manager.findOne(PanelEntity, { where: { code: input.panelCode, status: 'ACTIVE' } });
      if (!panel) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'پنل یافت نشد.' });
      }
      const existing = await manager.findOne(EntitlementEntity, { where: { principalId: target.id, panelId: panel.id } });
      if (existing) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'این دسترسی از قبل ثبت شده است.' });
      }
      const entitlement = manager.create(EntitlementEntity, {
        id: randomUUID(),
        principalId: target.id,
        panelId: panel.id,
        grantedByPrincipalId: actor.id,
        status: 'ACTIVE' as const,
      });
      await manager.save(entitlement);
      await this.appendControl(manager, {
        actorId: actor.id,
        action: 'entitlement.granted',
        objectType: 'entitlement',
        objectId: entitlement.id,
        correlationId,
        eventName: 'core.entitlement.granted.v1',
        payload: { entitlementId: entitlement.id, principalId: target.id, panelId: panel.id },
      });
      return entitlement;
    });
  }

  async issuePanelToken(actor: AuthenticatedPrincipal, panelCode: string): Promise<{ token: string; audience: string; expiresAt: string }> {
    const panel = await this.dataSource.getRepository(PanelEntity).findOne({ where: { code: panelCode, status: 'ACTIVE' } });
    if (!panel) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'پنل یافت نشد.' });
    }
    const entitlement = await this.dataSource.getRepository(EntitlementEntity).findOne({
      where: { principalId: actor.id, panelId: panel.id, status: 'ACTIVE' },
    });
    if (!entitlement || actor.realm !== 'STAFF') {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'به این پنل دسترسی ندارید.',
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.env.panelTokenTtlSeconds;
    const token = signPanelToken(
      {
        iss: this.env.panelTokenIssuer,
        sub: actor.id,
        aud: panel.audience,
        realm: actor.realm,
        sid: actor.sessionId,
        jti: randomUUID(),
        iat: now,
        exp,
      },
      this.env.panelTokenKeys,
    );
    return { token, audience: panel.audience, expiresAt: new Date(exp * 1000).toISOString() };
  }

  panelTokenJwks() {
    return panelTokenJwks(this.env.panelTokenKeys);
  }

  async registerRoute(actor: AuthenticatedPrincipal, input: RouteInput, correlationId: string): Promise<RouteContractEntity> {
    this.requirePlatformAdmin(actor);
    const route = this.validateRoute(input);
    return this.dataSource.transaction(async (manager) => {
      const clash = await manager.findOne(RouteContractEntity, {
        where: { method: route.method, pathPattern: route.pathPattern, version: route.version },
      });
      if (clash) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'این نسخه از مسیر از قبل ثبت شده است.' });
      }
      const entity = manager.create(RouteContractEntity, { id: randomUUID(), ...route });
      await manager.save(entity);
      await this.appendControl(manager, {
        actorId: actor.id,
        action: 'gateway.route.registered',
        objectType: 'route_contract',
        objectId: entity.id,
        correlationId,
        eventName: 'core.gateway.route.registered.v1',
        payload: {
          routeId: entity.id,
          method: entity.method,
          pathPattern: entity.pathPattern,
          version: entity.version,
          audience: entity.audience,
        },
      });
      return entity;
    });
  }

  async decideRoute(
    authorization: string | undefined,
    request: { method: string; pathPattern: string; version: string },
  ): Promise<{
    audience: string;
    upstreamBaseUrl: string;
    timeoutMs: number;
    version: string;
  }> {
    const token = this.readBearer(authorization);
    const unauthenticated = new UnauthorizedException({
      code: ErrorCode.UNAUTHENTICATED,
      message: 'نشست معتبر نیست.',
    });
    let payload: Record<string, string | number>;
    try {
      payload = verifyPanelToken(token, this.env.panelTokenKeys, {
        issuer: this.env.panelTokenIssuer,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
    } catch {
      throw unauthenticated;
    }
    // A panel token dies with the session that issued it (logout, rotation, expiry).
    const sid = typeof payload.sid === 'string' && /^[0-9a-f-]{36}$/i.test(payload.sid) ? payload.sid : null;
    if (!sid) {
      throw unauthenticated;
    }
    const session = await this.dataSource.getRepository(SessionEntity).findOne({ where: { id: sid } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || session.principalId !== payload.sub) {
      throw unauthenticated;
    }
    const route = await this.dataSource.getRepository(RouteContractEntity).findOne({
      where: { method: request.method.toUpperCase(), pathPattern: request.pathPattern, version: request.version },
    });
    if (!route) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'مسیر درگاه یافت نشد.' });
    }
    const realm = String(payload.realm ?? '');
    const allowed = route.allowedRealms.split(',');
    if (payload.aud !== route.audience || !allowed.includes(realm)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'توکن این پنل برای این مسیر پذیرفته نیست.',
      });
    }
    return {
      audience: route.audience,
      upstreamBaseUrl: route.upstreamBaseUrl,
      timeoutMs: route.timeoutMs,
      version: route.version,
    };
  }

  async probeUpstream(actor: AuthenticatedPrincipal, routeId: string): Promise<{ isolated: true }> {
    this.requirePlatformAdmin(actor);
    const route = await this.dataSource.getRepository(RouteContractEntity).findOne({ where: { id: routeId } });
    if (!route) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'مسیر درگاه یافت نشد.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);
    try {
      const response = await fetch(route.upstreamBaseUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
      await response.body?.cancel();
      return { isolated: true };
    } catch {
      throw new ConflictException({
        code: ErrorCode.UPSTREAM_TIMEOUT,
        message: 'سرویس بالادست در مهلت مقرر پاسخ نداد. هسته در دسترس ماند.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async startWorkflow(
    actor: AuthenticatedPrincipal,
    input: { definitionKey: string; ownerService: string; correlationId: string },
    idempotencyKey: string,
  ): Promise<{ id: string; status: WorkflowStatus; ownerService: string }> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) =>
      this.idempotent(manager, actor.id, 'workflow.start', idempotencyKey, input, async () => {
        const run = manager.create(WorkflowRunEntity, {
          id: randomUUID(),
          definitionKey: input.definitionKey,
          ownerService: input.ownerService,
          correlationId: input.correlationId,
          status: 'PENDING' as const,
          attempt: 0,
          idempotencyKey,
          startedByPrincipalId: actor.id,
          nextTimerAt: null,
        });
        await manager.save(run);
        await this.appendControl(manager, {
          actorId: actor.id,
          action: 'workflow.started',
          objectType: 'workflow_run',
          objectId: run.id,
          correlationId: input.correlationId,
          eventName: 'core.workflow.started.v1',
          payload: { workflowRunId: run.id, definitionKey: run.definitionKey, ownerService: run.ownerService },
        });
        return { id: run.id, status: run.status, ownerService: run.ownerService };
      }),
    );
  }

  async transitionWorkflow(actor: AuthenticatedPrincipal, id: string, to: WorkflowStatus, correlationId: string): Promise<WorkflowRunEntity> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) => {
      // Row lock serialises concurrent transitions so a terminal state cannot be overwritten.
      const run = await manager.findOne(WorkflowRunEntity, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!run) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'اجرای گردش‌کار یافت نشد.' });
      }
      if (run.startedByPrincipalId !== actor.id && actor.role !== 'PLATFORM_ADMIN') {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'فقط آغازکننده یا مدیر سکو می‌تواند وضعیت این گردش‌کار را تغییر دهد.',
        });
      }
      try {
        assertWorkflowTransition(run.status, to);
      } catch {
        throw new ConflictException({
          code: ErrorCode.ILLEGAL_TRANSITION,
          message: 'این تغییر وضعیت گردش‌کار مجاز نیست.',
        });
      }
      const from = run.status;
      run.status = to;
      run.attempt += 1;
      await manager.save(run);
      await this.appendControl(manager, {
        actorId: actor.id,
        action: 'workflow.transitioned',
        objectType: 'workflow_run',
        objectId: run.id,
        correlationId,
        eventName: 'core.workflow.transitioned.v1',
        payload: { workflowRunId: run.id, from, status: to },
      });
      return run;
    });
  }

  async recordConsent(
    actor: AuthenticatedPrincipal,
    input: { purpose: 'ANALYTICS' | 'ADVERTISING'; policyVersion: string; decision: 'GRANTED' | 'WITHDRAWN' },
    correlationId: string,
  ): Promise<ConsentRecordEntity> {
    return this.dataSource.transaction(async (manager) => {
      const record = manager.create(ConsentRecordEntity, {
        id: randomUUID(),
        principalId: actor.id,
        purpose: input.purpose,
        policyVersion: input.policyVersion,
        decision: input.decision,
      });
      await manager.save(record);
      await this.appendControl(manager, {
        actorId: actor.id,
        action: 'consent.recorded',
        objectType: 'consent',
        objectId: record.id,
        correlationId,
        eventName: 'core.consent.recorded.v1',
        payload: { consentId: record.id, purpose: input.purpose, decision: input.decision },
      });
      return record;
    });
  }

  async consentSnapshot(actor: AuthenticatedPrincipal): Promise<{ analytics: boolean; advertising: boolean }> {
    const records = await this.dataSource.getRepository(ConsentRecordEntity).find({
      where: { principalId: actor.id },
      order: { recordedAt: 'DESC' },
    });
    const latest = (purpose: 'ANALYTICS' | 'ADVERTISING') => records.find((row) => row.purpose === purpose);
    return {
      analytics: latest('ANALYTICS')?.decision === 'GRANTED',
      advertising: latest('ADVERTISING')?.decision === 'GRANTED',
    };
  }

  async listAudit(actor: AuthenticatedPrincipal): Promise<AuditEventEntity[]> {
    this.requirePlatformAdmin(actor);
    return this.dataSource.getRepository(AuditEventEntity).find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  /**
   * Claims a batch with SKIP LOCKED so parallel dispatchers never deliver the same row twice,
   * marks each row published only after the publisher accepts it, and records failures for retry.
   * Broker ingress must durably accept an event before the database row is acknowledged.
   * Consumers deduplicate by eventId if delivery succeeds but the DB commit fails.
   */
  async dispatchOutbox(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const pending = await manager
        .createQueryBuilder(OutboxEventEntity, 'event')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('event.publishedAt IS NULL')
        .orderBy('event.createdAt', 'ASC')
        .limit(OUTBOX_BATCH)
        .getMany();
      let count = 0;
      for (const event of pending) {
        try {
          await this.publish({
            eventId: event.eventId,
            eventName: event.eventName,
            aggregateId: event.aggregateId,
            payload: event.payload,
          });
          event.publishedAt = new Date();
          event.lastError = null;
          count += 1;
        } catch (error) {
          event.lastError = error instanceof Error ? error.message.slice(0, 500) : 'publish failed';
        }
        event.attempts += 1;
        await manager.save(event);
      }
      return count;
    });
  }

  private async publish(event: PublishedEvent): Promise<void> {
    if (!this.env.outboxPublishUrl) {
      if (this.env.nodeEnv === 'test') {
        this.acceptedEvents.push(event);
        return;
      }
      throw new Error('OUTBOX_PUBLISH_URL is not configured');
    }
    const response = await fetch(this.env.outboxPublishUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': event.eventId,
        ...(this.env.outboxPublishToken ? { authorization: `Bearer ${this.env.outboxPublishToken}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`Broker ingress rejected event: HTTP ${response.status}`);
    }
    this.acceptedEvents.push(event);
  }

  publishedEvents(): PublishedEvent[] {
    return [...this.acceptedEvents];
  }

  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= argon2.hash(randomToken(), ARGON2_OPTIONS);
    return this.dummyPasswordHash;
  }

  /**
   * Runs a command at most once per (principal, scope, key). A transaction-scoped advisory lock
   * serialises concurrent retries of the same key; a different payload under the same key is rejected.
   */
  private async idempotent<T extends Record<string, unknown>>(
    manager: EntityManager,
    principalId: string,
    scope: string,
    key: string,
    input: object,
    run: () => Promise<T>,
  ): Promise<T> {
    const requestHash = sha256(JSON.stringify(input));
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${principalId}|${scope}|${key}`]);
    const existing = await manager.findOne(IdempotencyRecordEntity, { where: { principalId, scope, key } });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          code: ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
          message: 'کلید تکرار با محتوای متفاوت ارسال شده است.',
        });
      }
      return existing.responseJson as T;
    }
    const result = await run();
    await manager.save(IdempotencyRecordEntity, {
      id: randomUUID(),
      principalId,
      scope,
      key,
      requestHash,
      responseJson: result,
    });
    return result;
  }

  private validateRoute(input: RouteInput): Omit<RouteContractEntity, 'id' | 'createdAt'> {
    const invalid = (message: string) => new BadRequestException({ code: ErrorCode.VALIDATION, message });
    const method = input.method.toUpperCase();
    if (!ROUTE_METHODS.includes(method)) {
      throw invalid('متد مسیر مجاز نیست.');
    }
    if (!/^\/v\d+(\/[A-Za-z0-9._~{}-]+)+$/.test(input.pathPattern)) {
      throw invalid('الگوی مسیر باید نسخه‌دار باشد، مانند /v1/crew/roster.');
    }
    if (!/^v\d+$/.test(input.version)) {
      throw invalid('نسخه مسیر باید به شکل v1 باشد.');
    }
    let upstream: URL;
    try {
      upstream = new URL(input.upstreamBaseUrl);
    } catch {
      throw invalid('نشانی سرویس بالادست نامعتبر است.');
    }
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
      throw invalid('نشانی سرویس بالادست باید http یا https و بدون اعتبارنامه یا پارامتر باشد.');
    }
    if (this.env.nodeEnv === 'production' && upstream.protocol !== 'https:') {
      throw invalid('در محیط عملیاتی نشانی سرویس بالادست باید https باشد.');
    }
    const realms = [...new Set(input.allowedRealms)];
    if (realms.length === 0 || realms.some((realm) => !REALMS.includes(realm as PrincipalEntity['realm']))) {
      throw invalid('قلمرو مجاز مسیر نامعتبر است.');
    }
    return {
      method,
      pathPattern: input.pathPattern,
      upstreamBaseUrl: upstream.toString(),
      audience: input.audience,
      timeoutMs: input.timeoutMs,
      allowedRealms: realms.join(','),
      version: input.version,
    };
  }

  private async openSession(principalId: string) {
    return this.dataSource.transaction(async (manager) => this.insertSession(manager, principalId));
  }

  private async insertSession(manager: EntityManager, principalId: string) {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const session = manager.create(SessionEntity, {
      id: randomUUID(),
      principalId,
      tokenHash: sha256(sessionToken),
      csrfHash: sha256(csrfToken),
      expiresAt: new Date(Date.now() + this.env.sessionTtlSeconds * 1000),
      revokedAt: null,
      replacedBySessionId: null,
    });
    await manager.save(session);
    const principal = await manager.findOneByOrFail(PrincipalEntity, { id: principalId });
    return {
      principal: {
        id: principal.id,
        realm: principal.realm,
        username: principal.username,
        role: principal.role,
        sessionId: session.id,
        csrfToken,
      },
      sessionId: session.id,
      sessionToken,
      csrfToken,
    };
  }

  private async appendControl(
    manager: EntityManager,
    input: {
      actorId: string;
      action: string;
      objectType: string;
      objectId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, string>;
    },
  ): Promise<void> {
    await manager.save(AuditEventEntity, {
      id: randomUUID(),
      actorPrincipalId: input.actorId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      correlationId: input.correlationId,
    });
    await manager.save(OutboxEventEntity, {
      id: randomUUID(),
      eventId: randomUUID(),
      eventName: input.eventName,
      aggregateId: input.objectId,
      payload: input.payload,
      publishedAt: null,
    });
  }

  private async requirePrincipal(id: string): Promise<PrincipalEntity> {
    const principal = await this.dataSource.getRepository(PrincipalEntity).findOne({ where: { id } });
    if (!principal) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'هویت یافت نشد.' });
    }
    return principal;
  }

  private requirePlatformAdmin(actor: AuthenticatedPrincipal): void {
    if (actor.realm !== 'STAFF' || actor.role !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'این عملیات فقط برای مدیر سکو مجاز است.',
      });
    }
  }

  private requireStaff(actor: AuthenticatedPrincipal): void {
    if (actor.realm !== 'STAFF') {
      throw new ForbiddenException({
        code: ErrorCode.REALM_REJECTED,
        message: 'هویت مشتری یا آژانس به عملیات کارکنان دسترسی ندارد.',
      });
    }
  }

  private readBearer(authorization: string | undefined): string {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'نشست معتبر نیست.',
      });
    }
    return authorization.slice('Bearer '.length);
  }
}
