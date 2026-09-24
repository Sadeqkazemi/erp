import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CoreEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import {
  AuditEventEntity,
  OutboxEventEntity,
  PanelEntity,
  PrincipalEntity,
  RouteContractEntity,
  ServiceObservationEntity,
  ServiceOperationalProfileEntity,
} from '../src/database/entities';
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

  it('versions operational ownership targets with optimistic concurrency and immutable history', async () => {
    const suffix = randomUUID();
    const ownerService = `ops-${suffix}`;
    await db.getRepository(PanelEntity).save({
      id: randomUUID(), code: `panel-${suffix}`, ownerService, classification: 'INTERNAL',
      titleFa: 'عملیات آزمون', titleEn: 'Test operations', audience: `panel:ops-${suffix}`, status: 'ACTIVE',
    });
    const input = {
      expectedCurrentVersion: 0, ownerTeam: 'Platform Operations', onCallRoute: 'platform-primary',
      runbookUrl: 'https://runbooks.internal/platform-core', availabilityTargetBps: 9990,
      latencyP95TargetMs: 500, rtoMinutes: 60, rpoMinutes: 15,
    };
    const first = await core.publishServiceOperationalProfile(admin, ownerService, input, `profile-${suffix}`, 'profile-corr-1');
    expect(first).toMatchObject({ ownerService, version: 1, availabilityTargetBps: 9990 });
    await expect(core.publishServiceOperationalProfile(
      admin, ownerService, input, `profile-conflict-${suffix}`, 'profile-corr-2',
    )).rejects.toMatchObject({ status: 409 });
    const second = await core.publishServiceOperationalProfile(admin, ownerService, {
      ...input, expectedCurrentVersion: 1, latencyP95TargetMs: 450,
    }, `profile-v2-${suffix}`, 'profile-corr-3');
    expect(second).toMatchObject({ ownerService, version: 2, latencyP95TargetMs: 450 });

    const versions = await db.getRepository(ServiceOperationalProfileEntity).find({
      where: { ownerService }, order: { version: 'ASC' },
    });
    expect(versions.map((profile) => profile.version)).toEqual([1, 2]);
    await expect(db.query(
      `UPDATE service_operational_profiles SET "rtoMinutes" = 1 WHERE id = $1`, [versions[0].id],
    )).rejects.toThrow();
    await expect(db.getRepository(AuditEventEntity).findOneByOrFail({
      action: 'service.operational_profile.published', objectId: second.id,
    })).resolves.toBeDefined();
    await expect(db.getRepository(OutboxEventEntity).findOneByOrFail({
      eventName: 'core.service.operational-profile.published.v1', aggregateId: second.id,
    })).resolves.toMatchObject({ publishedAt: null });
  });
});
