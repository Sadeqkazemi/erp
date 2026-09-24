import { DataSource } from 'typeorm';
import { CoreEnv } from '../config/env';
import { ServiceObservationEntity } from '../database/entities';
import { AuthenticatedPrincipal, PlatformCoreService } from './platform-core.service';

describe('registered service catalog', () => {
  const admin = { realm: 'STAFF', role: 'PLATFORM_ADMIN' } as AuthenticatedPrincipal;
  const query = jest.fn();
  const core = new PlatformCoreService({ query } as unknown as DataSource, {} as CoreEnv);

  beforeEach(() => query.mockReset());

  it('rejects staff without the admin role before accessing service metadata', async () => {
    await expect(core.listRegisteredServices({ ...admin, role: 'MEMBER' })).rejects.toMatchObject({ status: 403 });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses a parameterized bounded cursor and never fabricates live health', async () => {
    query.mockResolvedValue([
      { ownerService: 'crew', activePanels: 2, registeredRoutes: 1, health: 'UP', lastObservedAt: new Date('2026-09-24T12:00:00Z'), averageLatencyMs: 42 },
      { ownerService: 'ops', activePanels: 1, registeredRoutes: 0, health: 'UNKNOWN', lastObservedAt: null, averageLatencyMs: null },
    ]);
    const page = await core.listRegisteredServices(admin, 1, 'commerce');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('GROUP BY p."ownerService"'), ['commerce', 2]);
    expect(page.nextCursor).toBe('crew');
    expect(page.services).toEqual([{
      ownerService: 'crew', activePanels: 2, registeredRoutes: 1, health: 'UP',
      lastObservedAt: '2026-09-24T12:00:00.000Z', averageLatencyMs: 42, observationSource: 'MANUAL_PROBE',
      operationalReadiness: 'UNCONFIGURED', operationalProfile: null,
    }]);
  });

  it('rejects operational profile publication by non-admin staff before starting a transaction', async () => {
    const transaction = jest.fn();
    const profileCore = new PlatformCoreService({ transaction } as unknown as DataSource, {} as CoreEnv);
    await expect(profileCore.publishServiceOperationalProfile(
      { ...admin, role: 'MEMBER' }, 'crew-service', {
        expectedCurrentVersion: 0, ownerTeam: 'Crew Ops', onCallRoute: 'crew-primary',
        runbookUrl: 'https://runbooks.internal/crew', availabilityTargetBps: 9990,
        latencyP95TargetMs: 500, rtoMinutes: 60, rpoMinutes: 15,
      }, 'profile-key-1', 'corr',
    )).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('treats an HTTP 503 probe response as unhealthy', async () => {
    const route = { id: 'route', upstreamBaseUrl: 'https://service.internal', timeoutMs: 100 };
    const save = jest.fn(async (value) => ({ ...value, observedAt: new Date('2026-09-24T12:00:00Z') }));
    const db = { getRepository: (entity: unknown) => entity === ServiceObservationEntity
      ? { save } : { findOne: jest.fn().mockResolvedValue(route) } } as unknown as DataSource;
    const probeCore = new PlatformCoreService(db, {} as CoreEnv);
    const original = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, body: null }) as typeof fetch;
    try {
      await expect(probeCore.probeUpstream(admin, route.id)).rejects.toMatchObject({ status: 409 });
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ routeId: route.id, status: 'DOWN', httpStatus: 503, errorCode: 'HTTP_503' }));
    } finally {
      global.fetch = original;
    }
  });
});
