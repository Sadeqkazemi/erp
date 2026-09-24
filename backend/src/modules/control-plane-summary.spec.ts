import { DataSource } from 'typeorm';
import { CoreEnv } from '../config/env';
import { AuthenticatedPrincipal, PlatformCoreService } from './platform-core.service';

const actor: AuthenticatedPrincipal = {
  id: '11111111-1111-4111-8111-111111111111', realm: 'STAFF', role: 'PLATFORM_ADMIN',
  tenantId: null, username: 'operator', sessionId: '22222222-2222-4222-8222-222222222222', csrfToken: '',
};

describe('control-plane summary', () => {
  const query = jest.fn().mockResolvedValue([]);
  const core = new PlatformCoreService({ query } as unknown as DataSource, {} as CoreEnv);

  beforeEach(() => query.mockClear());

  it('denies non-admin callers without reading any operational counters', async () => {
    await expect(core.controlPlaneSummary({ ...actor, role: 'MEMBER' })).rejects.toMatchObject({ status: 403 });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns core counters while keeping unconnected sales explicitly unknown', async () => {
    query.mockResolvedValueOnce([{ total: 4, active: 3 }])
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([{ status: 'RUNNING', count: 1 }])
      .mockResolvedValueOnce([{ pending: 1, retried: 1, oldestAgeSeconds: 34 }])
      .mockResolvedValueOnce([{ day: '2026-09-24', count: 5 }]);
    const result = await core.controlPlaneSummary(actor);
    expect(result.panels).toEqual({ total: 4, active: 3 });
    expect(result.outbox).toEqual({ pending: 1, retried: 1, oldestAgeSeconds: 34 });
    expect(result.domainSales).toEqual({ status: 'UNCONFIGURED' });
  });
});
