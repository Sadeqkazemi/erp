import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CoreEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { AuthenticatedPrincipal, PlatformCoreService } from '../src/modules/platform-core.service';

const databaseUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('audit paging and access', () => {
  let db: DataSource;
  let core: PlatformCoreService;
  const actor: AuthenticatedPrincipal = {
    id: randomUUID(), realm: 'STAFF', role: 'PLATFORM_ADMIN', tenantId: null,
    username: 'audit-operator', sessionId: randomUUID(), csrfToken: '',
  };

  beforeAll(async () => {
    db = createDataSource(databaseUrl);
    await db.initialize();
    core = new PlatformCoreService(db, {} as CoreEnv);
  });
  afterAll(async () => { await db?.destroy(); });

  it('filters by correlation and pages deterministically without losing rows', async () => {
    const correlationId = randomUUID();
    const expected = new Set<string>();
    const sameSecond = new Date().toISOString().slice(0, 19);
    const actions = ['audit.test.created', 'audit.test.created', 'audit.test.other'];
    for (const [index, action] of actions.entries()) {
      const id = randomUUID();
      expected.add(id);
      // All three rows share a millisecond but have distinct database microseconds.
      const microseconds = ['123900', '123600', '123300'][index];
      await db.query(`INSERT INTO audit_events (id, action, "objectType", "objectId", "correlationId", "createdAt")
        VALUES ($1, $2, 'test', $3, $4, $5)`,
      [id, action, id, correlationId, `${sameSecond}.${microseconds}Z`]);
    }
    const first = await core.listAudit(actor, { correlationId, limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await core.listAudit(actor, { correlationId, limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id))).toEqual(expected);
    const filtered = await core.listAudit(actor, { correlationId, action: 'audit.test.created' });
    expect(filtered.rows).toHaveLength(2);
  });

  it('rejects invalid cursors, inverted time ranges and non-admin reads', async () => {
    await expect(core.listAudit(actor, { cursor: 'invalid' })).rejects.toMatchObject({ status: 400 });
    await expect(core.listAudit(actor, { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).rejects.toMatchObject({ status: 400 });
    await expect(core.listAudit({ ...actor, role: 'MEMBER' })).rejects.toMatchObject({ status: 403 });
  });
});
