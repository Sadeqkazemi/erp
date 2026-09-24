import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, LessThanOrEqual, Not } from 'typeorm';
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
  ServiceObservationEntity,
  SessionEntity,
  WorkflowRunEntity,
  WorkflowDefinitionEntity,
  WorkflowDefinitionStep,
  WorkflowStepEntity,
  VisitorConsentEntity,
} from '../database/entities';
import { assertWorkflowTransition, WorkflowStatus } from './workflow/workflow-transitions';
import { assertStepTransition, StepStatus } from './workflow/step-transitions';
import { nextOutboxRetryAt } from './outbox/retry-policy';

export interface AuthenticatedPrincipal {
  id: string;
  realm: PrincipalEntity['realm'];
  username: string;
  role: PrincipalEntity['role'];
  tenantId: string | null;
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

export interface AuditFilters {
  limit?: number;
  cursor?: string;
  action?: string;
  correlationId?: string;
  from?: string;
  to?: string;
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
    tenantId?: string;
  }): Promise<{ id: string; totpSecret: string | null }> {
    if ((input.realm === 'AGENCY' && !input.tenantId) || (input.realm !== 'AGENCY' && input.tenantId)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'شناسه آژانس برای هویت آژانس الزامی است.' });
    }
    if (input.tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.tenantId)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'شناسه آژانس نامعتبر است.' });
    }
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
      tenantId: input.tenantId ?? null,
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
    tenantId?: string;
  }): Promise<{ principal: AuthenticatedPrincipal; sessionToken: string; csrfToken: string }> {
    if (input.realm === 'WORKLOAD') {
      throw new ForbiddenException({
        code: ErrorCode.REALM_REJECTED,
        message: 'هویت سرویس با رمز عبور وارد نمی‌شود؛ از هویت کاری کوتاه‌عمر استفاده کنید.',
      });
    }
    const invalid = new UnauthorizedException({
      code: ErrorCode.INVALID_CREDENTIALS,
      message: 'نام کاربری یا رمز عبور نادرست است.',
    });
    if ((input.realm === 'AGENCY' && !input.tenantId) || (input.realm !== 'AGENCY' && input.tenantId)) {
      throw invalid;
    }
    const principal = await this.dataSource.getRepository(PrincipalEntity).findOne({
      where: {
        realm: input.realm, username: input.username, status: 'ACTIVE',
        ...(input.realm === 'AGENCY' ? { tenantId: input.tenantId } : {}),
      },
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
      tenantId: principal.tenantId,
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

  async listOwnSessions(actor: AuthenticatedPrincipal): Promise<Array<{
    id: string; current: boolean; createdAt: string; expiresAt: string; revokedAt: string | null; active: boolean;
  }>> {
    const sessions = await this.dataSource.getRepository(SessionEntity).find({
      where: { principalId: actor.id }, order: { createdAt: 'DESC' }, take: 100,
    });
    const now = Date.now();
    return sessions.map((session) => ({
      id: session.id,
      current: session.id === actor.sessionId,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      revokedAt: session.revokedAt?.toISOString() ?? null,
      active: !session.revokedAt && session.expiresAt.getTime() > now,
    }));
  }

  async revokeOwnSession(
    actor: AuthenticatedPrincipal, sessionId: string, correlationId: string,
  ): Promise<{ id: string; current: boolean; revoked: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(SessionEntity, {
        where: { id: sessionId, principalId: actor.id }, lock: { mode: 'pessimistic_write' },
      });
      if (!session) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'نشست یافت نشد.' });
      const newlyRevoked = !session.revokedAt;
      if (newlyRevoked) {
        session.revokedAt = new Date();
        await manager.save(session);
        await this.appendControl(manager, {
          actorId: actor.id, action: 'session.revoked', objectType: 'session', objectId: session.id,
          correlationId, eventName: 'identity.session.revoked.v1', payload: { sessionId: session.id },
        });
      }
      return { id: session.id, current: session.id === actor.sessionId, revoked: newlyRevoked };
    });
  }

  async disableStaffPrincipal(
    actor: AuthenticatedPrincipal, principalId: string, correlationId: string,
  ): Promise<{ id: string; status: 'DISABLED'; revokedSessions: number }> {
    this.requirePlatformAdmin(actor);
    if (actor.id === principalId) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'مدیر نمی‌تواند حساب فعال خودش را غیرفعال کند.' });
    }
    return this.dataSource.transaction(async (manager) => {
      const principal = await manager.findOne(PrincipalEntity, {
        where: { id: principalId }, lock: { mode: 'pessimistic_write' },
      });
      if (!principal) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'هویت یافت نشد.' });
      if (principal.realm !== 'STAFF') {
        throw new ForbiddenException({ code: ErrorCode.REALM_REJECTED, message: 'مدیریت هویت مشتری و آژانس در سرویس مالک آن انجام می‌شود.' });
      }
      const stateChanged = principal.status !== 'DISABLED';
      if (stateChanged) {
        principal.status = 'DISABLED';
        await manager.save(principal);
      }
      const revoked = await manager.update(SessionEntity, { principalId: principal.id, revokedAt: IsNull() }, { revokedAt: new Date() });
      if (stateChanged || (revoked.affected ?? 0) > 0) {
        await this.appendControl(manager, {
          actorId: actor.id, action: 'staff.disabled', objectType: 'principal', objectId: principal.id,
          correlationId, eventName: 'identity.staff.disabled.v1',
          payload: { principalId: principal.id, status: principal.status },
        });
      }
      return { id: principal.id, status: 'DISABLED', revokedSessions: revoked.affected ?? 0 };
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

  async revokeEntitlement(actor: AuthenticatedPrincipal, entitlementId: string, correlationId: string): Promise<EntitlementEntity> {
    this.requirePlatformAdmin(actor);
    return this.dataSource.transaction(async (manager) => {
      const entitlement = await manager.findOne(EntitlementEntity, {
        where: { id: entitlementId }, lock: { mode: 'pessimistic_write' },
      });
      if (!entitlement) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'دسترسی پنل یافت نشد.' });
      }
      if (entitlement.status === 'ACTIVE') {
        entitlement.status = 'REVOKED';
        await manager.save(entitlement);
        await this.appendControl(manager, {
          actorId: actor.id, action: 'entitlement.revoked', objectType: 'entitlement',
          objectId: entitlement.id, correlationId, eventName: 'core.entitlement.revoked.v1',
          payload: { entitlementId: entitlement.id, principalId: entitlement.principalId, panelId: entitlement.panelId },
        });
      }
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
        panelId: panel.id,
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
    const principal = await this.dataSource.getRepository(PrincipalEntity).findOne({ where: { id: session.principalId } });
    if (!principal || principal.status !== 'ACTIVE' || principal.realm !== payload.realm || principal.realm !== 'STAFF') {
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
    const panelId = typeof payload.panelId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.panelId) ? payload.panelId : null;
    const panel = panelId && await this.dataSource.getRepository(PanelEntity).findOne({
      where: { id: panelId, audience: route.audience, status: 'ACTIVE' },
    });
    const entitlement = panel && await this.dataSource.getRepository(EntitlementEntity).findOne({
      where: { principalId: principal.id, panelId: panel.id, status: 'ACTIVE' },
    });
    if (!entitlement) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'دسترسی این پنل لغو شده است.' });
    }
    return {
      audience: route.audience,
      upstreamBaseUrl: route.upstreamBaseUrl,
      timeoutMs: route.timeoutMs,
      version: route.version,
    };
  }

  async probeUpstream(actor: AuthenticatedPrincipal, routeId: string): Promise<{
    isolated: true; status: 'UP'; latencyMs: number; observedAt: string;
  }> {
    this.requirePlatformAdmin(actor);
    const route = await this.dataSource.getRepository(RouteContractEntity).findOne({ where: { id: routeId } });
    if (!route) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'مسیر درگاه یافت نشد.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(route.upstreamBaseUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
    } catch {
      await this.recordServiceObservation(route.id, 'DOWN', Date.now() - startedAt, null, 'FETCH_FAILED');
      throw new ConflictException({
        code: ErrorCode.UPSTREAM_TIMEOUT,
        message: 'سرویس بالادست در مهلت مقرر پاسخ نداد. هسته در دسترس ماند.',
      });
    } finally {
      clearTimeout(timer);
    }
    await response.body?.cancel();
    if (!response.ok) {
      await this.recordServiceObservation(route.id, 'DOWN', Date.now() - startedAt, response.status, `HTTP_${response.status}`);
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'سرویس بالادست پاسخ سالم نداد.' });
    }
    const observation = await this.recordServiceObservation(route.id, 'UP', Date.now() - startedAt, response.status, null);
    return { isolated: true, status: 'UP', latencyMs: observation.latencyMs, observedAt: observation.observedAt.toISOString() };
  }

  async startWorkflow(
    actor: AuthenticatedPrincipal,
    input: { definitionKey: string; ownerService: string; correlationId: string },
    idempotencyKey: string,
  ): Promise<{ id: string; status: WorkflowStatus; ownerService: string }> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) =>
      this.idempotent(manager, actor.id, 'workflow.start', idempotencyKey, input, async () => {
        const definition = await manager.findOne(WorkflowDefinitionEntity, { where: { definitionKey: input.definitionKey } });
        if (!definition && this.env.workflowDefinitionsRequired) {
          throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'تعریف گردش‌کار ثبت نشده است.' });
        }
        if (definition && definition.ownerService !== input.ownerService) {
          throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'مالک گردش‌کار با تعریف ثبت‌شده مطابقت ندارد.' });
        }
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

  async registerWorkflowDefinition(
    actor: AuthenticatedPrincipal,
    input: { definitionKey: string; ownerService: string; steps: WorkflowDefinitionStep[] },
    correlationId: string,
  ): Promise<WorkflowDefinitionEntity> {
    this.requirePlatformAdmin(actor);
    const keys = input.steps.map((step) => step.stepKey);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'کلید گام تکراری است.' });
    }
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`workflow.definition|${input.definitionKey}`]);
      const existing = await manager.findOne(WorkflowDefinitionEntity, { where: { definitionKey: input.definitionKey } });
      if (existing) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'نسخهٔ تعریف از قبل ثبت شده است.' });
      const definition = await manager.save(manager.create(WorkflowDefinitionEntity, {
        id: randomUUID(), definitionKey: input.definitionKey, ownerService: input.ownerService, steps: input.steps,
      }));
      await this.appendControl(manager, {
        actorId: actor.id, action: 'workflow.definition.registered', objectType: 'workflow_definition',
        objectId: definition.id, correlationId, eventName: 'core.workflow.definition.registered.v1',
        payload: { definitionId: definition.id, definitionKey: definition.definitionKey, ownerService: definition.ownerService },
      });
      return definition;
    });
  }

  async transitionWorkflow(actor: AuthenticatedPrincipal, id: string, to: WorkflowStatus, correlationId: string): Promise<WorkflowRunEntity> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) => {
      // Row lock serialises concurrent transitions so a terminal state cannot be overwritten.
      const run = await manager.findOne(WorkflowRunEntity, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!run) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'اجرای گردش‌کار یافت نشد.' });
      }
      this.assertWorkflowActor(actor, run);
      try {
        assertWorkflowTransition(run.status, to);
      } catch {
        throw new ConflictException({
          code: ErrorCode.ILLEGAL_TRANSITION,
          message: 'این تغییر وضعیت گردش‌کار مجاز نیست.',
        });
      }
      if (to === 'COMPLETED' || to === 'COMPENSATED') {
        const steps = await manager.find(WorkflowStepEntity, { where: { workflowRunId: run.id } });
        const done = to === 'COMPLETED'
          ? steps.every((step) => step.status === 'SUCCEEDED')
          : steps.every((step) => step.status === 'COMPENSATED' || step.status === 'FAILED');
        if (!done) {
          throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'گام‌های گردش‌کار هنوز نهایی نشده‌اند.' });
        }
      }
      if (to === 'FAILED') {
        const successful = await manager.findOne(WorkflowStepEntity, { where: { workflowRunId: run.id, status: 'SUCCEEDED' } });
        if (successful) {
          throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'گام‌های موفق باید ابتدا جبران شوند.' });
        }
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

  async createWorkflowStep(
    actor: AuthenticatedPrincipal, workflowRunId: string,
    input: { stepKey: string; timeoutSeconds: number }, idempotencyKey: string, correlationId: string,
  ): Promise<{ id: string; stepKey: string; status: StepStatus; deadlineAt: string }> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) => {
      const run = await manager.findOne(WorkflowRunEntity, { where: { id: workflowRunId }, lock: { mode: 'pessimistic_write' } });
      if (!run) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'اجرای گردش‌کار یافت نشد.' });
      this.assertWorkflowActor(actor, run);
      if (run.status !== 'RUNNING' && run.status !== 'WAITING') {
        throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'اجرای گردش‌کار آماده ثبت گام نیست.' });
      }
      const definition = await manager.findOne(WorkflowDefinitionEntity, { where: { definitionKey: run.definitionKey } });
      if (!definition && this.env.workflowDefinitionsRequired) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'تعریف گردش‌کار ثبت نشده است.' });
      }
      if (definition && !definition.steps.some((step) => step.stepKey === input.stepKey && step.timeoutSeconds === input.timeoutSeconds)) {
        throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'گام یا مهلت آن در تعریف ثبت‌شده نیست.' });
      }
      return this.idempotent(manager, actor.id, `workflow.step.${workflowRunId}`, idempotencyKey, input, async () => {
        const existing = await manager.findOne(WorkflowStepEntity, { where: { workflowRunId, stepKey: input.stepKey } });
        if (existing) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'این گام قبلاً ثبت شده است.' });
        const step = manager.create(WorkflowStepEntity, {
          id: randomUUID(), workflowRunId, stepKey: input.stepKey, status: 'PENDING' as const,
          attempt: 0, deadlineAt: new Date(Date.now() + input.timeoutSeconds * 1000),
        });
        await manager.save(step);
        await this.appendControl(manager, {
          actorId: actor.id, action: 'workflow.step.created', objectType: 'workflow_step', objectId: step.id,
          correlationId, eventName: 'core.workflow.step.created.v1',
          payload: { workflowRunId, stepId: step.id, stepKey: step.stepKey },
        });
        return { id: step.id, stepKey: step.stepKey, status: step.status, deadlineAt: step.deadlineAt.toISOString() };
      });
    });
  }

  async transitionWorkflowStep(
    actor: AuthenticatedPrincipal, workflowRunId: string, stepKey: string, to: StepStatus, correlationId: string,
  ): Promise<WorkflowStepEntity> {
    this.requireStaff(actor);
    return this.dataSource.transaction(async (manager) => {
      const run = await manager.findOne(WorkflowRunEntity, { where: { id: workflowRunId }, lock: { mode: 'pessimistic_write' } });
      if (!run) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'اجرای گردش‌کار یافت نشد.' });
      this.assertWorkflowActor(actor, run);
      const step = await manager.findOne(WorkflowStepEntity, {
        where: { workflowRunId, stepKey }, lock: { mode: 'pessimistic_write' },
      });
      if (!step) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'گام گردش‌کار یافت نشد.' });
      try {
        assertStepTransition(step.status, to);
      } catch {
        throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'تغییر وضعیت گام مجاز نیست.' });
      }
      if (['PENDING', 'RUNNING'].includes(step.status) && step.deadlineAt.getTime() <= Date.now()) {
        throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'مهلت گام به پایان رسیده است.' });
      }
      if ((to === 'COMPENSATING' || to === 'COMPENSATED') && run.status !== 'COMPENSATING') {
        throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'اجرای گردش‌کار در وضعیت جبران نیست.' });
      }
      if (to !== 'COMPENSATING' && to !== 'COMPENSATED' && run.status !== 'RUNNING' && run.status !== 'WAITING') {
        throw new ConflictException({ code: ErrorCode.ILLEGAL_TRANSITION, message: 'اجرای گردش‌کار فعال نیست.' });
      }
      const from = step.status;
      step.status = to;
      step.attempt += 1;
      await manager.save(step);
      await this.appendControl(manager, {
        actorId: actor.id, action: 'workflow.step.transitioned', objectType: 'workflow_step', objectId: step.id,
        correlationId, eventName: 'core.workflow.step.transitioned.v1',
        payload: { workflowRunId, stepId: step.id, from, status: to },
      });
      return step;
    });
  }

  async expireWorkflowSteps(): Promise<number> {
    const candidates = await this.dataSource.getRepository(WorkflowStepEntity).find({
      where: { status: In(['PENDING', 'RUNNING']), deadlineAt: LessThanOrEqual(new Date()) },
      order: { deadlineAt: 'ASC' }, take: 50,
    });
    let count = 0;
    for (const candidate of candidates) {
      const expired = await this.dataSource.transaction(async (manager) => {
        // Always lock the run before the step, matching manual transition lock order.
        const run = await manager.findOne(WorkflowRunEntity, {
          where: { id: candidate.workflowRunId }, lock: { mode: 'pessimistic_write' },
        });
        if (!run) return false;
        const step = await manager.findOne(WorkflowStepEntity, { where: { id: candidate.id }, lock: { mode: 'pessimistic_write' } });
        if (!step || !['PENDING', 'RUNNING'].includes(step.status) || step.deadlineAt.getTime() > Date.now()) return false;
        step.status = 'FAILED';
        step.attempt += 1;
        await manager.save(step);
        if (run.status === 'RUNNING' || run.status === 'WAITING') {
          const success = await manager.findOne(WorkflowStepEntity, { where: { workflowRunId: run.id, status: 'SUCCEEDED' } });
          run.status = success ? 'COMPENSATING' : 'FAILED';
          await manager.save(run);
        }
        await this.appendControl(manager, {
          actorId: null, action: 'workflow.step.expired', objectType: 'workflow_step', objectId: step.id,
          correlationId: run.correlationId, eventName: 'core.workflow.step.expired.v1',
          payload: { workflowRunId: run.id, stepId: step.id, status: 'FAILED' },
        });
        return true;
      });
      if (expired) count += 1;
    }
    return count;
  }

  private assertWorkflowActor(actor: AuthenticatedPrincipal, run: WorkflowRunEntity): void {
    if (run.startedByPrincipalId !== actor.id && actor.role !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'فقط آغازکننده یا مدیر سکو می‌تواند گردش‌کار را تغییر دهد.' });
    }
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

  async recordVisitorConsent(
    visitorToken: string,
    input: { purpose: 'ANALYTICS' | 'ADVERTISING'; policyVersion: string; decision: 'GRANTED' | 'WITHDRAWN' },
    correlationId: string,
  ): Promise<VisitorConsentEntity> {
    if (!this.validVisitorToken(visitorToken)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'شناسه بازدیدکننده معتبر نیست.' });
    }
    return this.dataSource.transaction(async (manager) => {
      const record = manager.create(VisitorConsentEntity, {
        id: randomUUID(), visitorHash: sha256(visitorToken), ...input,
      });
      await manager.save(record);
      await this.appendControl(manager, {
        actorId: null, action: 'visitor.consent.recorded', objectType: 'visitor_consent',
        objectId: record.id, correlationId, eventName: 'core.visitor.consent.recorded.v1',
        payload: { consentId: record.id, purpose: input.purpose, decision: input.decision },
      });
      return record;
    });
  }

  async visitorConsentSnapshot(visitorToken: string | undefined): Promise<{ analytics: boolean; advertising: boolean }> {
    if (!visitorToken || !this.validVisitorToken(visitorToken)) {
      return { analytics: false, advertising: false };
    }
    const rows = await this.dataSource.getRepository(VisitorConsentEntity).find({
      where: { visitorHash: sha256(visitorToken) }, order: { recordedAt: 'DESC', id: 'DESC' },
    });
    const latest = (purpose: 'ANALYTICS' | 'ADVERTISING') => rows.find((row) => row.purpose === purpose);
    return { analytics: latest('ANALYTICS')?.decision === 'GRANTED', advertising: latest('ADVERTISING')?.decision === 'GRANTED' };
  }

  private validVisitorToken(token: string): boolean {
    return /^[A-Za-z0-9_-]{40,90}$/.test(token);
  }

  async listAudit(actor: AuthenticatedPrincipal, filters: AuditFilters = {}): Promise<{ rows: AuditEventEntity[]; nextCursor: string | null }> {
    this.requirePlatformAdmin(actor);
    const limit = filters.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'تعداد رویدادهای درخواستی نامعتبر است.' });
    }
    const from = filters.from ? new Date(filters.from) : null;
    const to = filters.to ? new Date(filters.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'بازه زمانی ممیزی نامعتبر است.' });
    }
    let cursor: { createdAt: string; id: string } | null = null;
    if (filters.cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8'));
        const value = parsed as { createdAt?: unknown; id?: unknown };
        if (typeof value.createdAt !== 'string' || typeof value.id !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.createdAt) ||
          Number.isNaN(Date.parse(value.createdAt)) || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error('invalid cursor');
        cursor = { createdAt: value.createdAt, id: value.id };
      } catch {
        throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'نشانگر صفحه ممیزی نامعتبر است.' });
      }
    }
    const query = this.dataSource.getRepository(AuditEventEntity).createQueryBuilder('audit');
    if (filters.action) query.andWhere('audit.action = :action', { action: filters.action });
    if (filters.correlationId) query.andWhere('audit.correlationId = :correlationId', { correlationId: filters.correlationId });
    if (from) query.andWhere('audit.createdAt >= :from', { from });
    if (to) query.andWhere('audit.createdAt <= :to', { to });
    if (cursor) query.andWhere('(audit.createdAt < :cursorTime OR (audit.createdAt = :cursorTime AND audit.id < :cursorId))', {
      cursorTime: cursor.createdAt, cursorId: cursor.id,
    });
    const found = await query
      .addSelect("to_char(audit.createdAt AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')", 'cursorTime')
      .orderBy('audit.createdAt', 'DESC').addOrderBy('audit.id', 'DESC').take(limit + 1).getRawAndEntities();
    const rows = found.entities.slice(0, limit);
    const last = rows.at(-1);
    return {
      rows,
      nextCursor: found.entities.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: found.raw[limit - 1].cursorTime as string, id: last.id })).toString('base64url')
        : null,
    };
  }

  async controlPlaneSummary(actor: AuthenticatedPrincipal) {
    this.requirePlatformAdmin(actor);
    const [panels, routes, workflows, outbox, dailyAudit] = await Promise.all([
      this.dataSource.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'ACTIVE')::int AS active FROM panels`),
      this.dataSource.query('SELECT count(*)::int AS total FROM route_contracts'),
      this.dataSource.query('SELECT status, count(*)::int AS count FROM workflow_runs GROUP BY status ORDER BY status'),
      this.dataSource.query(`SELECT
        count(*) FILTER (WHERE "deadLetterAt" IS NULL)::int AS pending,
        count(*) FILTER (WHERE "deadLetterAt" IS NULL AND attempts > 0)::int AS retried,
        count(*) FILTER (WHERE "deadLetterAt" IS NOT NULL)::int AS "deadLetters",
        extract(epoch FROM (now() - min("createdAt") FILTER (WHERE "deadLetterAt" IS NULL)))::int AS "oldestAgeSeconds",
        extract(epoch FROM (now() - min("deadLetterAt")))::int AS "oldestDeadLetterAgeSeconds"
        FROM outbox_events WHERE "publishedAt" IS NULL`),
      this.dataSource.query(`SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        count(*)::int AS count FROM audit_events
        WHERE "createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days'
        GROUP BY day ORDER BY day`),
    ]);
    return {
      asOf: new Date().toISOString(),
      panels: panels[0], routes: routes[0], workflows,
      outbox: outbox[0], auditLastSevenUtcDays: dailyAudit,
      domainSales: { status: 'UNCONFIGURED' },
    };
  }

  async listRegisteredServices(actor: AuthenticatedPrincipal, limit = 100, cursor?: string) {
    this.requirePlatformAdmin(actor);
    const rows = await this.dataSource.query(`WITH service_panels AS (
        SELECT p."ownerService", count(DISTINCT p.id)::int AS "activePanels"
        FROM panels p WHERE p.status = 'ACTIVE' AND ($1::varchar IS NULL OR p."ownerService" > $1)
        GROUP BY p."ownerService"
      ), service_routes AS (
        SELECT DISTINCT p."ownerService", r.id AS "routeId"
        FROM panels p JOIN route_contracts r ON r.audience = p.audience WHERE p.status = 'ACTIVE'
      ), route_latest AS (
        SELECT sr."ownerService", sr."routeId", o.status, o."latencyMs", o."observedAt"
        FROM service_routes sr LEFT JOIN LATERAL (
          SELECT status, "latencyMs", "observedAt" FROM service_observations
          WHERE "routeId" = sr."routeId" ORDER BY "observedAt" DESC LIMIT 1
        ) o ON true
      ) SELECT sp."ownerService", sp."activePanels", count(rl."routeId")::int AS "registeredRoutes",
        CASE WHEN count(rl."routeId") = 0 OR count(rl."observedAt") = 0 THEN 'UNKNOWN'
          WHEN count(*) FILTER (WHERE rl."observedAt" IS NULL OR rl."observedAt" < now() - interval '5 minutes') > 0 THEN 'STALE'
          WHEN bool_and(rl.status = 'UP') THEN 'UP' WHEN bool_and(rl.status = 'DOWN') THEN 'DOWN' ELSE 'DEGRADED' END AS health,
        max(rl."observedAt") AS "lastObservedAt",
        round(avg(rl."latencyMs") FILTER (WHERE rl."observedAt" >= now() - interval '5 minutes'))::int AS "averageLatencyMs"
      FROM service_panels sp LEFT JOIN route_latest rl ON rl."ownerService" = sp."ownerService"
      GROUP BY sp."ownerService", sp."activePanels" ORDER BY sp."ownerService" LIMIT $2`, [cursor ?? null, limit + 1]) as Array<{
      ownerService: string; activePanels: number; registeredRoutes: number;
      health: 'UNKNOWN' | 'UP' | 'DOWN' | 'DEGRADED' | 'STALE';
      lastObservedAt: Date | null; averageLatencyMs: number | null;
    }>;
    const page = rows.slice(0, limit);
    return {
      asOf: new Date().toISOString(),
      services: page.map((row) => ({
        ...row, lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
        observationSource: row.lastObservedAt ? 'MANUAL_PROBE' as const : null,
      })),
      nextCursor: rows.length > limit ? page.at(-1)?.ownerService ?? null : null,
    };
  }

  private recordServiceObservation(
    routeId: string, status: 'UP' | 'DOWN', latencyMs: number, httpStatus: number | null, errorCode: string | null,
  ): Promise<ServiceObservationEntity> {
    return this.dataSource.getRepository(ServiceObservationEntity).save({
      id: randomUUID(), routeId, status, httpStatus,
      latencyMs: Math.max(0, Math.min(300000, latencyMs)), errorCode, source: 'MANUAL_PROBE',
    });
  }

  async listDeadLetters(actor: AuthenticatedPrincipal): Promise<Array<{
    id: string; eventId: string; eventName: string; aggregateId: string;
    attempts: number; lastError: string | null; deadLetterAt: Date | null;
  }>> {
    this.requirePlatformAdmin(actor);
    const events = await this.dataSource.getRepository(OutboxEventEntity).find({
      where: { publishedAt: IsNull(), deadLetterAt: Not(IsNull()) },
      order: { deadLetterAt: 'DESC' }, take: 100,
    });
    return events.map(({ id, eventId, eventName, aggregateId, attempts, lastError, deadLetterAt }) =>
      ({ id, eventId, eventName, aggregateId, attempts, lastError, deadLetterAt }));
  }

  async requeueDeadLetter(actor: AuthenticatedPrincipal, id: string, correlationId: string): Promise<OutboxEventEntity> {
    this.requirePlatformAdmin(actor);
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(OutboxEventEntity, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!event) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'رویداد یافت نشد.' });
      if (event.publishedAt || !event.deadLetterAt) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'رویداد در صف بررسی مجدد نیست.' });
      }
      event.deadLetterAt = null;
      event.nextAttemptAt = null;
      event.attempts = 0;
      event.lastError = null;
      await manager.save(event);
      await this.appendControl(manager, {
        actorId: actor.id, action: 'outbox.dead_letter.requeued', objectType: 'outbox_event', objectId: event.id,
        correlationId, eventName: 'core.outbox.dead_letter.requeued.v1',
        payload: { outboxEventId: event.id, eventId: event.eventId },
      });
      return event;
    });
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
        .where('event.publishedAt IS NULL AND event.deadLetterAt IS NULL')
        .andWhere('(event.nextAttemptAt IS NULL OR event.nextAttemptAt <= now())')
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
          event.nextAttemptAt = null;
          count += 1;
        } catch (error) {
          event.lastError = error instanceof Error ? error.message.slice(0, 500) : 'publish failed';
          const now = new Date();
          const next = nextOutboxRetryAt(event.attempts + 1, now);
          event.nextAttemptAt = next;
          if (!next) event.deadLetterAt = now;
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
    if (this.env.nodeEnv === 'test') {
      this.acceptedEvents.push(event);
    }
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
        tenantId: principal.tenantId,
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
      actorId: string | null;
      action: string;
      objectType: string;
      objectId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, string>;
    },
  ): Promise<void> {
    const actor = input.actorId ? await manager.findOneByOrFail(PrincipalEntity, { id: input.actorId }) : null;
    await manager.save(AuditEventEntity, {
      id: randomUUID(),
      actorPrincipalId: input.actorId,
      tenantId: actor?.tenantId ?? null,
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
        nextAttemptAt: null,
        deadLetterAt: null,
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
