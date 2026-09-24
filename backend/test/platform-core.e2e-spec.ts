import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { spawnSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, Server } from 'http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { PrincipalEntity } from '../src/database/entities';
import { PlatformCoreService } from '../src/modules/platform-core.service';
import { DataSource } from 'typeorm';

const postgresBin = process.env.POSTGRES_BIN ?? 'C:\\Program Files\\PostgreSQL\\18\\bin';
const postgresPort = 55441;
const exe = process.platform === 'win32' ? '.exe' : '';

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
  let broker: Server;
  const delivered = new Set<string>();
  const gatewayRequests: Array<Record<string, unknown>> = [];
  let brokerAvailable = true;

  beforeAll(async () => {
    broker = createServer((req, res) => {
      if (!brokerAvailable) {
        res.writeHead(503).end();
        return;
      }
      if (req.url?.startsWith('/v1/gateway-fixture/')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const received = {
            method: req.method,
            url: req.url,
            body: raw ? JSON.parse(raw) as unknown : null,
            authorization: req.headers.authorization,
            idempotencyKey: req.headers['idempotency-key'],
            cookie: req.headers.cookie ?? null,
            requestId: req.headers['x-request-id'],
          };
          gatewayRequests.push(received);
          if (req.url?.startsWith('/v1/gateway-fixture/redirect')) {
            res.setHeader('location', 'https://untrusted.example/redirected');
            res.writeHead(302).end();
            return;
          }
          if (req.url?.startsWith('/v1/gateway-fixture/large')) {
            const large = JSON.stringify({ payload: 'x'.repeat(2048) });
            res.setHeader('content-type', 'application/json');
            res.setHeader('content-length', String(Buffer.byteLength(large)));
            res.writeHead(200).end(large);
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.setHeader('set-cookie', 'domain-session=must-not-leak');
          res.setHeader('x-internal-secret', 'must-not-leak');
          res.writeHead(200).end(JSON.stringify(received));
        });
        return;
      }
      const key = req.headers['idempotency-key'];
      if (typeof key === 'string') delivered.add(key);
      req.resume();
      res.writeHead(202).end();
    });
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve));
    const address = broker.address();
    if (!address || typeof address === 'string') throw new Error('Broker fixture did not bind');
    process.env.OUTBOX_PUBLISH_URL = `http://127.0.0.1:${address.port}`;
    process.env.OUTBOX_PUBLISH_TOKEN = 'test-token';
    const externalUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
    if (externalUrl) {
      process.env.DATABASE_URL = externalUrl;
    } else {
      ownsCluster = true;
      dataDir = mkdtempSync(join(tmpdir(), 'bj-core-'));
    const init = spawnSync(join(postgresBin, `initdb${exe}`), ['-D', dataDir, '-U', 'core', '--auth=trust', '--encoding=UTF8', '--locale=C'], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || init.stdout || 'initdb failed');
    }
    const started = spawnSync(join(postgresBin, `pg_ctl${exe}`), ['-D', dataDir, '-W', '-o', `-p ${postgresPort}`, 'start'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    if (started.status !== 0) {
      throw new Error(started.stderr || started.stdout || 'pg_ctl start failed');
    }
    let readyMessage = 'postgres did not become ready';
    let becameReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = spawnSync(join(postgresBin, `pg_isready${exe}`), ['-h', '127.0.0.1', '-p', String(postgresPort)], {
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
    process.env.PANEL_TOKEN_PRIVATE_KEY = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    process.env.MFA_ENCRYPTION_KEY = '11'.repeat(32);
    process.env.ALLOWED_ORIGINS = ORIGIN;
    process.env.SESSION_TTL_SECONDS = '900';
    process.env.GATEWAY_MAX_REQUEST_BYTES = '1024';
    process.env.GATEWAY_MAX_RESPONSE_BYTES = '1024';
    const env = loadEnv();
    // Schema is applied with the migration role when CI provides one; the app then runs as the runtime role.
    const migrator = createDataSource(process.env.PLATFORM_CORE_TEST_MIGRATION_DATABASE_URL ?? env.databaseUrl);
    await migrator.initialize();
    await migrator.runMigrations();
    await migrator.destroy();
    dataSource = createDataSource(env.databaseUrl);
    await dataSource.initialize();
    const moduleRef = await Test.createTestingModule({
      // The suite logs in far more often than the per-minute login limit allows.
      imports: [AppModule.register(env, dataSource, { logging: false, rateLimit: false })],
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
    if (broker) await new Promise<void>((resolve, reject) => broker.close((error) => error ? reject(error) : resolve()));
    if (dataDir && ownsCluster) {
      spawnSync(join(postgresBin, `pg_ctl${exe}`), ['-D', dataDir, '-w', '-m', 'fast', 'stop'], { encoding: 'utf8' });
    }
  });

  async function login(username: string, password: string, totp?: string) {
    // Each TOTP step is single-use; tests log in repeatedly within one step, so clear the marker first.
    if (totp) {
      await dataSource.query('UPDATE principals SET "lastTotpStep" = NULL WHERE username = $1', [username]);
    }
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
      .send({ method: 'GET', pathPattern: '/v1/crew/roster', version: 'v1' })
      .expect(201);
    expect(allowed.body.data.audience).toBe('panel:crew');

    const gatewayRoute = await request(app.getHttpServer())
      .post('/v1/gateway/routes')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({
        method: 'POST',
        pathPattern: '/v1/gateway-fixture/{id}',
        upstreamBaseUrl: new URL(process.env.OUTBOX_PUBLISH_URL ?? '').origin,
        audience: 'panel:crew',
        timeoutMs: 500,
        allowedRealms: 'STAFF',
        version: 'v1',
      })
      .expect(201);
    const forwarded = await request(app.getHttpServer())
      .post(`/v1/gateway/routes/${gatewayRoute.body.data.id}/forward/v1/gateway-fixture/abc-123?day=1`)
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .set('Cookie', 'untrusted-domain-cookie=secret')
      .set('Idempotency-Key', 'domain-write-0001')
      .send({ action: 'inspect' })
      .expect(200);
    expect(forwarded.body).toMatchObject({
      method: 'POST', url: '/v1/gateway-fixture/abc-123?day=1', body: { action: 'inspect' },
      idempotencyKey: 'domain-write-0001', cookie: null,
    });
    expect(forwarded.body.authorization).toMatch(/^Bearer /);
    expect(forwarded.body.requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(forwarded.headers['set-cookie']).toBeUndefined();
    expect(forwarded.headers['x-internal-secret']).toBeUndefined();
    expect(gatewayRequests).toHaveLength(1);
    await request(app.getHttpServer())
      .post(`/v1/gateway/routes/${gatewayRoute.body.data.id}/forward/v1/not-the-contract`)
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .send({ action: 'deny' })
      .expect(403);
    const redirect = await request(app.getHttpServer())
      .post(`/v1/gateway/routes/${gatewayRoute.body.data.id}/forward/v1/gateway-fixture/redirect`)
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .send({ action: 'redirect' })
      .expect(502);
    expect(redirect.body.error.code).toBe('UPSTREAM_REJECTED');
    const large = await request(app.getHttpServer())
      .post(`/v1/gateway/routes/${gatewayRoute.body.data.id}/forward/v1/gateway-fixture/large`)
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .send({ action: 'large' })
      .expect(502);
    expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const oversized = await request(app.getHttpServer())
      .post(`/v1/gateway/routes/${gatewayRoute.body.data.id}/forward/v1/gateway-fixture/oversized`)
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .send({ payload: 'x'.repeat(1500) })
      .expect(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');

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
      .set('Idempotency-Key', 'wf-illegal-1')
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
    const published = delivered.size;
    const second = await core.dispatchOutbox();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(delivered.size).toBe(published);
  });

  describe('hardening regressions', () => {
    type Session = Awaited<ReturnType<typeof login>>;
    const mutate = (req: request.Test, session: Session) =>
      req.set('Cookie', session.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', session.csrf);
    const panelBody = (code: string) => ({
      code,
      ownerService: 'crew-service',
      classification: 'INTERNAL',
      titleFa: 'آزمون',
      titleEn: 'Test',
      audience: `panel:${code}`,
    });
    const routeBody = (pathPattern: string, upstreamBaseUrl = 'http://127.0.0.1:9') => ({
      method: 'GET',
      pathPattern,
      upstreamBaseUrl,
      audience: 'panel:crew',
      timeoutMs: 50,
      allowedRealms: 'STAFF',
      version: 'v1',
    });
    const staffLogin = () => login('crew-lead', 'Staff-pass-1', staffTotp);
    const adminLogin = () => login('platform-admin', adminPassword, adminTotp);

    it('serialises concurrent workflow transitions so a terminal state is never overwritten', async () => {
      const admin = await adminLogin();
      const srv = app.getHttpServer();
      const started = await mutate(request(srv).post('/v1/workflow-runs'), admin)
        .set('Idempotency-Key', 'wf-race-0001')
        .send({ definitionKey: 'commerce.order.v1', ownerService: 'commerce', correlationId: 'corr-race' })
        .expect(201);
      const id = started.body.data.id as string;
      await mutate(request(srv).post(`/v1/workflow-runs/${id}/transitions`), admin).send({ to: 'RUNNING' }).expect(201);
      const results = await Promise.all(
        ['COMPLETED', 'FAILED', 'WAITING'].map((to) =>
          mutate(request(srv).post(`/v1/workflow-runs/${id}/transitions`), admin).send({ to }),
        ),
      );
      const ok = results.filter((r) => r.status === 201);
      const [row] = (await dataSource.query('SELECT status, attempt, version FROM workflow_runs WHERE id = $1', [id])) as {
        status: string;
        attempt: number;
      }[];
      // Every interleaving must be a legal sequence from RUNNING; the stored attempt counts every applied transition.
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(row.attempt).toBe(1 + ok.length);
      expect(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'ILLEGAL_TRANSITION')).toBe(true);
      if (ok.some((r) => r.body.data.status === 'COMPLETED')) {
        expect(row.status).toBe('COMPLETED');
      }
    });

    it('lets only the starter or a platform admin transition a workflow run', async () => {
      const admin = await adminLogin();
      const staff = await staffLogin();
      const srv = app.getHttpServer();
      const started = await mutate(request(srv).post('/v1/workflow-runs'), admin)
        .set('Idempotency-Key', 'wf-owner-0001')
        .send({ definitionKey: 'commerce.order.v1', ownerService: 'commerce', correlationId: 'corr-owner' })
        .expect(201);
      const denied = await mutate(request(srv).post(`/v1/workflow-runs/${started.body.data.id}/transitions`), staff)
        .send({ to: 'RUNNING' })
        .expect(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
      const own = await mutate(request(srv).post('/v1/workflow-runs'), staff)
        .set('Idempotency-Key', 'wf-owner-0002')
        .send({ definitionKey: 'commerce.order.v1', ownerService: 'commerce', correlationId: 'corr-owner-2' })
        .expect(201);
      await mutate(request(srv).post(`/v1/workflow-runs/${own.body.data.id}/transitions`), staff).send({ to: 'RUNNING' }).expect(201);
    });

    it('scopes idempotency keys to the caller and the operation', async () => {
      const admin = await adminLogin();
      const staff = await staffLogin();
      const srv = app.getHttpServer();
      const body = { definitionKey: 'commerce.order.v1', ownerService: 'commerce', correlationId: 'corr-shared' };
      const a = await mutate(request(srv).post('/v1/workflow-runs'), admin).set('Idempotency-Key', 'shared-key-0001').send(body).expect(201);
      const b = await mutate(request(srv).post('/v1/workflow-runs'), staff).set('Idempotency-Key', 'shared-key-0001').send(body).expect(201);
      expect(b.body.data.id).not.toBe(a.body.data.id);
      const replay = await mutate(request(srv).post('/v1/workflow-runs'), admin).set('Idempotency-Key', 'shared-key-0001').send(body).expect(201);
      expect(replay.body.data.id).toBe(a.body.data.id);
      await mutate(request(srv).post('/v1/panels'), admin).set('Idempotency-Key', 'shared-key-0001').send(panelBody('scoped')).expect(201);
    });

    it('registers one panel when the same idempotency key is retried concurrently', async () => {
      const admin = await adminLogin();
      const srv = app.getHttpServer();
      const results = await Promise.all(
        [1, 2, 3].map(() => mutate(request(srv).post('/v1/panels'), admin).set('Idempotency-Key', 'panel-concurrent-1').send(panelBody('concurrent'))),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      const [{ n }] = (await dataSource.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'panel.registered' AND \"objectId\" = $1", [
        results[0].body.data.id,
      ])) as { n: number }[];
      expect(n).toBe(1);
    });

    it('returns 409 instead of 500 for duplicate panels and entitlements', async () => {
      const admin = await adminLogin();
      const srv = app.getHttpServer();
      await mutate(request(srv).post('/v1/panels'), admin).set('Idempotency-Key', 'panel-dup-0001').send(panelBody('dup')).expect(201);
      const panel = await mutate(request(srv).post('/v1/panels'), admin).set('Idempotency-Key', 'panel-dup-0002').send(panelBody('dup')).expect(409);
      expect(panel.body.error.code).toBe('CONFLICT');
      await mutate(request(srv).post('/v1/entitlements'), admin).send({ principalId: staffId, panelCode: 'dup' }).expect(201);
      const grant = await mutate(request(srv).post('/v1/entitlements'), admin).send({ principalId: staffId, panelCode: 'dup' }).expect(409);
      expect(grant.body.error.code).toBe('CONFLICT');
    });

    it('audits route registration, validates upstreams and restricts probes to platform admins', async () => {
      const admin = await adminLogin();
      const staff = await staffLogin();
      const customer = await login('09120000000', 'Customer-pass-1');
      const srv = app.getHttpServer();
      const route = await mutate(request(srv).post('/v1/gateway/routes'), admin).send(routeBody('/v1/crew/duty')).expect(201);
      const [{ n }] = (await dataSource.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'gateway.route.registered' AND \"objectId\" = $1", [
        route.body.data.id,
      ])) as { n: number }[];
      expect(n).toBe(1);
      await mutate(request(srv).post('/v1/gateway/routes'), admin).send(routeBody('/v1/crew/duty')).expect(409);
      await mutate(request(srv).post('/v1/gateway/routes'), admin).send(routeBody('/v1/crew/x', 'file:///etc/passwd')).expect(400);
      await mutate(request(srv).post('/v1/gateway/routes'), admin).send(routeBody('/v1/crew/y', 'http://user:pw@crew.internal')).expect(400);
      await mutate(request(srv).post('/v1/gateway/routes'), admin).send(routeBody('crew/unversioned')).expect(400);
      for (const session of [customer, staff]) {
        const probe = await mutate(request(srv).post(`/v1/gateway/routes/${route.body.data.id}/probe`), session);
        expect(probe.status).toBe(403);
      }
    });

    it('requires an allowed Origin for logout and rotation and clears both cookies', async () => {
      const staff = await staffLogin();
      const srv = app.getHttpServer();
      for (const path of ['/v1/sessions/rotate', '/v1/sessions/logout']) {
        const denied = await request(srv).post(path).set('Cookie', staff.cookie).set('X-CSRF-Token', staff.csrf).expect(401);
        expect(denied.body.error.code).toBe('CSRF_REJECTED');
      }
      const out = await mutate(request(srv).post('/v1/sessions/logout'), staff).expect(201);
      const cleared = ([] as string[]).concat(out.headers['set-cookie'] ?? []);
      expect(cleared).toEqual(
        expect.arrayContaining([expect.stringMatching(/^bj_session=;.*HttpOnly.*SameSite=Lax/), expect.stringMatching(/^bj_csrf=;.*SameSite=Lax/)]),
      );
    });

    it('rejects login CSRF from an unknown Origin, workload password login and TOTP replay', async () => {
      const srv = app.getHttpServer();
      await request(srv)
        .post('/v1/sessions')
        .set('Origin', 'https://evil.example')
        .send({ realm: 'CUSTOMER', username: '09120000000', password: 'Customer-pass-1' })
        .expect(401);
      const workload = await request(srv).post('/v1/sessions').send({ realm: 'WORKLOAD', username: 'svc', password: 'whatever-123' }).expect(403);
      expect(workload.body.error.code).toBe('REALM_REJECTED');
      await dataSource.query('UPDATE principals SET "lastTotpStep" = NULL WHERE username = $1', ['crew-lead']);
      const code = core.currentTotp(staffTotp);
      const send = () => request(srv).post('/v1/sessions').send({ realm: 'STAFF', username: 'crew-lead', password: 'Staff-pass-1', totp: code });
      await send().expect(201);
      const replay = await send().expect(401);
      expect(replay.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('signs panel tokens with a published Ed25519 key and revokes them with the session', async () => {
      const staff = await staffLogin();
      const srv = app.getHttpServer();
      const jwks = await request(srv).get('/.well-known/jwks.json').expect(200);
      expect(jwks.body.keys[0]).toEqual(expect.objectContaining({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' }));
      expect(jwks.body.keys[0]).not.toHaveProperty('d');
      const issued = await mutate(request(srv).post('/v1/panels/crew/access-tokens'), staff).expect(201);
      const token = issued.body.data.token as string;
      const decide = (bearer: string) =>
        request(srv).post('/v1/gateway/decisions').set('Authorization', `Bearer ${bearer}`).send({ method: 'GET', pathPattern: '/v1/crew/roster', version: 'v1' });
      await decide(token).expect(201);
      const [h, p, sig] = token.split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
      const forged = Buffer.from(JSON.stringify({ ...claims, aud: 'panel:finance' })).toString('base64url');
      await decide(`${h}.${forged}.${sig}`).expect(401);
      await mutate(request(srv).post('/v1/sessions/logout'), staff).expect(201);
      await decide(token).expect(401);
    });

    it('keeps the audit log append-only at the database level', async () => {
      await expect(dataSource.query('UPDATE audit_events SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
      // Under the runtime role DELETE is refused by grants before the trigger fires; either layer suffices.
      await expect(dataSource.query('DELETE FROM audit_events')).rejects.toThrow(/append-only|permission denied/);
    });

    it('never dispatches the same outbox row twice when dispatchers run in parallel', async () => {
      const admin = await adminLogin();
      await mutate(request(app.getHttpServer()).post('/v1/panels'), admin).set('Idempotency-Key', 'panel-outbox-01').send(panelBody('outbox'));
      const [{ n: pending }] = (await dataSource.query('SELECT count(*)::int AS n FROM outbox_events WHERE "publishedAt" IS NULL')) as { n: number }[];
      const before = delivered.size;
      const counts = await Promise.all([core.dispatchOutbox(), core.dispatchOutbox(), core.dispatchOutbox()]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(pending);
      expect(delivered.size - before).toBe(pending);
      const [{ n: left }] = (await dataSource.query('SELECT count(*)::int AS n FROM outbox_events WHERE "publishedAt" IS NULL')) as { n: number }[];
      expect(left).toBe(0);
    });
    it('keeps unacknowledged events pending and retries after the broker recovers', async () => {
      const admin = await adminLogin();
      await mutate(request(app.getHttpServer()).post('/v1/panels'), admin).set('Idempotency-Key', 'panel-retry-01').send(panelBody('retry'));
      brokerAvailable = false;
      expect(await core.dispatchOutbox()).toBe(0);
      const [{ n: pending }] = (await dataSource.query('SELECT count(*)::int AS n FROM outbox_events WHERE "publishedAt" IS NULL')) as { n: number }[];
      expect(pending).toBeGreaterThan(0);
      brokerAvailable = true;
      // Advance the durable retry schedule without a wall-clock sleep; immediate retries must remain blocked by backoff.
      await dataSource.query('UPDATE outbox_events SET "nextAttemptAt" = now() WHERE "publishedAt" IS NULL');
      expect(await core.dispatchOutbox()).toBe(pending);
    });
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
