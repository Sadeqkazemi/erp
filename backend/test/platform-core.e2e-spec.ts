import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { PrincipalEntity } from '../src/database/entities';
import { PlatformCoreService } from '../src/modules/platform-core.service';
import { DataSource } from 'typeorm';

const postgresBin = process.env.POSTGRES_BIN ?? 'C:\\Program Files\\PostgreSQL\\18\\bin';
const postgresPort = 55441;

const ORIGIN = 'http://localhost:5173';

describe('platform core', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let core: PlatformCoreService;
  let dataDir = '';
  let ownsCluster = false;
  let adminTotp = '';
  let adminPassword = '';
  let staffId = '';
  let staffTotp = '';

  beforeAll(async () => {
    const externalUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
    if (externalUrl) {
      process.env.DATABASE_URL = externalUrl;
    } else {
      ownsCluster = true;
      dataDir = mkdtempSync(join(tmpdir(), 'bj-core-'));
    const init = spawnSync(join(postgresBin, 'initdb.exe'), ['-D', dataDir, '-U', 'core', '--auth=trust', '--encoding=UTF8', '--locale=C'], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || init.stdout || 'initdb failed');
    }
    const started = spawnSync(join(postgresBin, 'pg_ctl.exe'), ['-D', dataDir, '-W', '-o', `-p ${postgresPort}`, 'start'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    if (started.status !== 0) {
      throw new Error(started.stderr || started.stdout || 'pg_ctl start failed');
    }
    let readyMessage = 'postgres did not become ready';
    let becameReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = spawnSync(join(postgresBin, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(postgresPort)], {
        encoding: 'utf8',
      });
      if (ready.status === 0) {
        becameReady = true;
        break;
      }
      readyMessage = ready.stdout || ready.stderr || readyMessage;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!becameReady) {
      throw new Error(readyMessage);
    }
      process.env.DATABASE_URL = `postgresql://core@127.0.0.1:${postgresPort}/postgres`;
    }
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECURE = 'false';
    process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-characters';
    process.env.MFA_ENCRYPTION_KEY = '11'.repeat(32);
    process.env.ALLOWED_ORIGINS = ORIGIN;
    process.env.SESSION_TTL_SECONDS = '900';
    const env = loadEnv();
    dataSource = createDataSource(env.databaseUrl);
    await dataSource.initialize();
    await dataSource.runMigrations();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, dataSource, { logging: false })],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    const server = app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void };
    server.set('allowedOrigins', env.allowedOrigins);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    core = app.get(PlatformCoreService);
    adminPassword = 'Admin-pass-1';
    const admin = await core.createPrincipal({
      realm: 'STAFF',
      username: 'platform-admin',
      password: adminPassword,
      role: 'PLATFORM_ADMIN',
    });
    adminTotp = admin.totpSecret ?? '';
    const staff = await core.createPrincipal({
      realm: 'STAFF',
      username: 'crew-lead',
      password: 'Staff-pass-1',
      role: 'MEMBER',
    });
    staffId = staff.id;
    staffTotp = staff.totpSecret ?? '';
    await core.createPrincipal({
      realm: 'CUSTOMER',
      username: '09120000000',
      password: 'Customer-pass-1',
      role: 'MEMBER',
    });
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    if (dataDir && ownsCluster) {
      spawnSync(join(postgresBin, 'pg_ctl.exe'), ['-D', dataDir, '-w', '-m', 'fast', 'stop'], { encoding: 'utf8' });
    }
  });

  async function login(username: string, password: string, totp?: string) {
    const response = await request(app.getHttpServer())
      .post('/v1/sessions')
      .send({ realm: totp ? 'STAFF' : 'CUSTOMER', username, password, totp: totp ? core.currentTotp(totp) : undefined })
      .expect(201);
    const cookie = response.headers['set-cookie'];
    const csrf = response.body.data.csrfToken as string;
    return { cookie, csrf };
  }

  it('rejects a staff login without the second factor', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/sessions')
      .send({ realm: 'STAFF', username: 'platform-admin', password: adminPassword })
      .expect(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns an empty launcher until another admin grants a panel', async () => {
    const session = await login('crew-lead', 'Staff-pass-1', staffTotp);
    const response = await request(app.getHttpServer())
      .get('/v1/panels')
      .set('Cookie', session.cookie)
      .expect(200);
    expect(response.body.data).toEqual([]);
  });

  it('blocks self-grant, customer entitlements, and cross-panel tokens', async () => {
    const admin = await login('platform-admin', adminPassword, adminTotp);
    const adminPrincipal = await core.authenticate(readSession(admin.cookie));
    const created = await request(app.getHttpServer())
      .post('/v1/panels')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .set('Idempotency-Key', 'panel-crew-1')
      .send({
        code: 'crew',
        ownerService: 'crew-service',
        classification: 'INTERNAL',
        titleFa: 'خدمه',
        titleEn: 'Crew',
        audience: 'panel:crew',
      })
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/v1/panels')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .set('Idempotency-Key', 'panel-crew-1')
      .send({
        code: 'other',
        ownerService: 'crew-service',
        classification: 'INTERNAL',
        titleFa: 'دیگر',
        titleEn: 'Other',
        audience: 'panel:other',
      })
      .expect(409);
    expect(replay.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(created.body.data.code).toBe('crew');

    const selfGrant = await request(app.getHttpServer())
      .post('/v1/entitlements')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({ principalId: adminPrincipal.id, panelCode: 'crew' })
      .expect(403);
    expect(selfGrant.body.error.code).toBe('SELF_GRANT_FORBIDDEN');

    const customer = await dataSource.getRepository(PrincipalEntity).findOneByOrFail({ username: '09120000000' });
    const customerGrant = await request(app.getHttpServer())
      .post('/v1/entitlements')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({ principalId: customer.id, panelCode: 'crew' })
      .expect(403);
    expect(customerGrant.body.error.code).toBe('REALM_REJECTED');

    await request(app.getHttpServer())
      .post('/v1/entitlements')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({ principalId: staffId, panelCode: 'crew' })
      .expect(201);

    const staff = await login('crew-lead', 'Staff-pass-1', staffTotp);
    const launcher = await request(app.getHttpServer()).get('/v1/panels').set('Cookie', staff.cookie).expect(200);
    expect(launcher.body.data).toEqual([
      expect.objectContaining({ code: 'crew', titleFa: 'خدمه', titleEn: 'Crew' }),
    ]);

    const token = await request(app.getHttpServer())
      .post('/v1/panels/crew/access-tokens')
      .set('Cookie', staff.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', staff.csrf)
      .expect(201);

    const route = await request(app.getHttpServer())
      .post('/v1/gateway/routes')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({
        method: 'GET',
        pathPattern: '/v1/crew/roster',
        upstreamBaseUrl: 'http://127.0.0.1:9',
        audience: 'panel:crew',
        timeoutMs: 50,
        allowedRealms: 'STAFF',
        version: 'v1',
      })
      .expect(201);

    const allowed = await request(app.getHttpServer())
      .post('/v1/gateway/decisions')
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .send({ method: 'GET', pathPattern: '/v1/crew/roster' })
      .expect(201);
    expect(allowed.body.data.audience).toBe('panel:crew');

    const customerSession = await login('09120000000', 'Customer-pass-1');
    const customerPanels = await request(app.getHttpServer())
      .post('/v1/panels')
      .set('Cookie', customerSession.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', customerSession.csrf)
      .set('Idempotency-Key', 'customer-panel')
      .send({
        code: 'hack',
        ownerService: 'none',
        classification: 'INTERNAL',
        titleFa: 'نفوذ',
        titleEn: 'Hack',
        audience: 'panel:crew',
      })
      .expect(403);
    expect(customerPanels.body.error.code).toBe('FORBIDDEN');

    const missingCsrf = await request(app.getHttpServer())
      .post('/v1/sessions/rotate')
      .set('Cookie', staff.cookie)
      .set('Origin', ORIGIN)
      .expect(403);
    expect(missingCsrf.body.error.code).toBe('CSRF_REJECTED');

    const probe = await request(app.getHttpServer())
      .post(`/v1/gateway/routes/${route.body.data.id}/probe`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .expect(409);
    expect(probe.body.error.code).toBe('UPSTREAM_TIMEOUT');
    const health = await request(app.getHttpServer()).get('/health').expect(200);
    expect(health.body.data.status).toBe('ok');
  });

  it('rotates the session and records consent withdrawal', async () => {
    const staff = await login('crew-lead', 'Staff-pass-1', staffTotp);
    const rotated = await request(app.getHttpServer())
      .post('/v1/sessions/rotate')
      .set('Cookie', staff.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', staff.csrf)
      .expect(201);
    const oldSession = await request(app.getHttpServer()).get('/v1/panels').set('Cookie', staff.cookie).expect(401);
    expect(oldSession.body.error.code).toBe('UNAUTHENTICATED');
    const freshCookie = rotated.headers['set-cookie'];
    const before = await request(app.getHttpServer()).get('/v1/consents/me').set('Cookie', freshCookie).expect(200);
    expect(before.body.data).toEqual({ analytics: false, advertising: false });
    await request(app.getHttpServer())
      .post('/v1/consents')
      .set('Cookie', freshCookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', rotated.body.data.csrfToken)
      .send({ purpose: 'ANALYTICS', policyVersion: '2026-09-01', decision: 'GRANTED' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/consents')
      .set('Cookie', freshCookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', rotated.body.data.csrfToken)
      .send({ purpose: 'ANALYTICS', policyVersion: '2026-09-01', decision: 'WITHDRAWN' })
      .expect(201);
    const after = await request(app.getHttpServer()).get('/v1/consents/me').set('Cookie', freshCookie).expect(200);
    expect(after.body.data.analytics).toBe(false);
  });

  it('rejects an illegal workflow transition and deduplicates the outbox', async () => {
    const admin = await login('platform-admin', adminPassword, adminTotp);
    const started = await request(app.getHttpServer())
      .post('/v1/workflow-runs')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .set('Idempotency-Key', 'wf-1')
      .send({ definitionKey: 'commerce.order.v1', ownerService: 'commerce', correlationId: 'corr-1' })
      .expect(201);
    const illegal = await request(app.getHttpServer())
      .post(`/v1/workflow-runs/${started.body.data.id}/transitions`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({ to: 'COMPLETED' })
      .expect(409);
    expect(illegal.body.error.code).toBe('ILLEGAL_TRANSITION');
    const first = await core.dispatchOutbox();
    const published = core.publishedEvents().length;
    const second = await core.dispatchOutbox();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(core.publishedEvents().length).toBe(published);
  });
});

function readSession(cookieHeader: string | string[]): string {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  const match = /bj_session=([^;]+)/.exec(raw);
  if (!match) {
    throw new Error('session cookie missing');
  }
  return decodeURIComponent(match[1]);
}
