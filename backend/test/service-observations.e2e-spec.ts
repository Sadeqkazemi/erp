import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CoreEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { PrincipalEntity, RouteContractEntity, ServiceObservationEntity } from '../src/database/entities';
import { AuthenticatedPrincipal, PlatformCoreService } from '../src/modules/platform-core.service';

const databaseUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('append-only route health observations', () => {
  let db: DataSource;
  let core: PlatformCoreService;
  let admin: AuthenticatedPrincipal;

  beforeAll(async () => {
    db = createDataSource(databaseUrl);
    await db.initialize();
    const id = randomUUID();
    await db.getRepository(PrincipalEntity).save({
      id, realm: 'STAFF', username: `observer-${id}`, tenantId: null, passwordHash: 'integration-fixture',
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', mfaSecretCiphertext: null, lastTotpStep: null,
    });
    admin = { id, realm: 'STAFF', username: `observer-${id}`, role: 'PLATFORM_ADMIN', tenantId: null, sessionId: randomUUID(), csrfToken: '' };
    core = new PlatformCoreService(db, {} as CoreEnv);
  });

  afterAll(async () => { await db?.destroy(); });

  it('records successful observations and prevents rewriting evidence', async () => {
    const route = await db.getRepository(RouteContractEntity).save({
      id: randomUUID(), method: 'GET', pathPattern: `/v1/health/${randomUUID()}`, upstreamBaseUrl: 'https://service.invalid/',
      audience: `panel:test-${randomUUID()}`, timeoutMs: 100, allowedRealms: 'STAFF', version: 'v1',
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await expect(core.probeUpstream(admin, route.id)).resolves.toMatchObject({ isolated: true, status: 'UP' });
    } finally {
      fetchMock.mockRestore();
    }
    const observation = await db.getRepository(ServiceObservationEntity).findOneByOrFail({ routeId: route.id });
    expect(observation).toMatchObject({ status: 'UP', httpStatus: 204, source: 'MANUAL_PROBE' });
    await expect(db.query(`UPDATE service_observations SET status = 'DOWN' WHERE id = $1`, [observation.id])).rejects.toThrow();
  });
});
