import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { ErrorCode } from '../common/errors';
import {
  csrfCookieName,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
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

export interface PublishedEvent {
  eventId: string;
  eventName: string;
  aggregateId: string;
  payload: Record<string, string>;
}

@Injectable()
export class PlatformCoreService {
  private readonly published: PublishedEvent[] = [];

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
      passwordHash: await argon2.hash(input.password, { memoryCost: 4096, timeCost: 2, parallelism: 1 }),
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
    const principal = await this.dataSource.getRepository(PrincipalEntity).findOne({
      where: { realm: input.realm, username: input.username, status: 'ACTIVE' },
    });
    const invalid = new UnauthorizedException({
      code: ErrorCode.INVALID_CREDENTIALS,
      message: 'نام کاربری یا رمز عبور نادرست است.',
    });
    if (!principal) {
      throw invalid;
    }
    const passwordOk = await argon2.verify(principal.passwordHash, input.password);
    if (!passwordOk) {
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
      if (!verifyTotp(secret, input.totp, new Date())) {
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
  ): Promise<PanelEntity> {
    this.requirePlatformAdmin(actor);
    const requestHash = sha256(JSON.stringify(input));
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(IdempotencyRecordEntity, { where: { key: idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            code: ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
            message: 'کلید تکرار با محتوای متفاوت ارسال شده است.',
          });
        }
        return existing.responseJson as unknown as PanelEntity;
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
      await manager.save(IdempotencyRecordEntity, {
        key: idempotencyKey,
        requestHash,
        responseJson: { ...panel },
      });
      return panel;
    });
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
    const panel = await this.dataSource.getRepository(PanelEntity).findOne({ where: { code: input.panelCode, status: 'ACTIVE' } });
    if (!panel) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'پنل یافت نشد.' });
    }
    return this.dataSource.transaction(async (manager) => {
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
      { sub: actor.id, aud: panel.audience, realm: actor.realm, exp },
      this.env.jwtSecret,
    );
    return { token, audience: panel.audience, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async registerRoute(input: {
    method: string;
    pathPattern: string;
    upstreamBaseUrl: string;
    audience: string;
    timeoutMs: number;
    allowedRealms: string[];
    version: string;
  }): Promise<RouteContractEntity> {
    const route = this.dataSource.getRepository(RouteContractEntity).create({
      id: randomUUID(),
      method: input.method.toUpperCase(),
      pathPattern: input.pathPattern,
      upstreamBaseUrl: input.upstreamBaseUrl,
      audience: input.audience,
      timeoutMs: input.timeoutMs,
      allowedRealms: input.allowedRealms.join(','),
      version: input.version,
    });
    await this.dataSource.getRepository(RouteContractEntity).save(route);
    return route;
  }

  async decideRoute(authorization: string | undefined, method: string, pathPattern: string): Promise<{
    audience: string;
    upstreamBaseUrl: string;
    timeoutMs: number;
    version: string;
  }> {
    const token = this.readBearer(authorization);
    let payload: Record<string, string | number>;
    try {
      payload = verifyPanelToken(token, this.env.jwtSecret, Math.floor(Date.now() / 1000));
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'نشست معتبر نیست.',
      });
    }
    const route = await this.dataSource.getRepository(RouteContractEntity).findOne({
      where: { method: method.toUpperCase(), pathPattern },
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

  async probeUpstream(routeId: string): Promise<{ isolated: true }> {
    const route = await this.dataSource.getRepository(RouteContractEntity).findOne({ where: { id: routeId } });
    if (!route) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'مسیر درگاه یافت نشد.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);
    try {
      await fetch(route.upstreamBaseUrl, { method: 'GET', signal: controller.signal });
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
  ): Promise<WorkflowRunEntity> {
    this.requireStaff(actor);
    const requestHash = sha256(JSON.stringify(input));
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(IdempotencyRecordEntity, { where: { key: idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            code: ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
            message: 'کلید تکرار با محتوای متفاوت ارسال شده است.',
          });
        }
        return existing.responseJson as unknown as WorkflowRunEntity;
      }
      const run = manager.create(WorkflowRunEntity, {
        id: randomUUID(),
        definitionKey: input.definitionKey,
        ownerService: input.ownerService,
        correlationId: input.correlationId,
        status: 'PENDING' as const,
        attempt: 0,
        idempotencyKey,
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
      await manager.save(IdempotencyRecordEntity, {
        key: idempotencyKey,
        requestHash,
        responseJson: { id: run.id, status: run.status, definitionKey: run.definitionKey, ownerService: run.ownerService },
      });
      return run;
    });
  }

  async transitionWorkflow(actor: AuthenticatedPrincipal, id: string, to: WorkflowStatus, correlationId: string): Promise<WorkflowRunEntity> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) => {
      const run = await manager.findOne(WorkflowRunEntity, { where: { id } });
      if (!run) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'اجرای گردش‌کار یافت نشد.' });
      }
      try {
        assertWorkflowTransition(run.status, to);
      } catch {
        throw new ConflictException({
          code: ErrorCode.ILLEGAL_TRANSITION,
          message: 'این تغییر وضعیت گردش‌کار مجاز نیست.',
        });
      }
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
        payload: { workflowRunId: run.id, status: to },
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

  async dispatchOutbox(): Promise<number> {
    const pending = await this.dataSource.getRepository(OutboxEventEntity).find({ where: { publishedAt: IsNull() } });
    let count = 0;
    for (const event of pending) {
      const already = this.published.some((item) => item.eventId === event.eventId);
      if (!already) {
        this.published.push({
          eventId: event.eventId,
          eventName: event.eventName,
          aggregateId: event.aggregateId,
          payload: event.payload,
        });
      }
      event.publishedAt = new Date();
      await this.dataSource.getRepository(OutboxEventEntity).save(event);
      count += 1;
    }
    return count;
  }

  publishedEvents(): PublishedEvent[] {
    return [...this.published];
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
