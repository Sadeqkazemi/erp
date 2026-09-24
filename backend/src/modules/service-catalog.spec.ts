import { DataSource } from 'typeorm';
import { CoreEnv } from '../config/env';
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
      { ownerService: 'crew', activePanels: 2, registeredRoutes: 1 },
      { ownerService: 'ops', activePanels: 1, registeredRoutes: 0 },
    ]);
    const page = await core.listRegisteredServices(admin, 1, 'commerce');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('GROUP BY p."ownerService"'), ['commerce', 2]);
    expect(page.nextCursor).toBe('crew');
    expect(page.services).toEqual([{ ownerService: 'crew', activePanels: 2, registeredRoutes: 1, health: 'UNKNOWN', lastObservedAt: null }]);
  });

  it('treats an HTTP 503 probe response as unhealthy', async () => {
    const route = { id: 'route', upstreamBaseUrl: 'https://service.internal', timeoutMs: 100 };
    const db = { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(route) }) } as unknown as DataSource;
    const probeCore = new PlatformCoreService(db, {} as CoreEnv);
    const original = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, body: null }) as typeof fetch;
    try {
      await expect(probeCore.probeUpstream(admin, route.id)).rejects.toMatchObject({ status: 409 });
    } finally {
      global.fetch = original;
    }
  });
});
