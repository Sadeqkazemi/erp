import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, IsNull } from 'typeorm';
import { CoreEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { PrincipalEntity, SessionEntity } from '../src/database/entities';
import { AuthenticatedPrincipal, PlatformCoreService } from '../src/modules/platform-core.service';

const databaseUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('staff and session lifecycle', () => {
  let db: DataSource;
  let core: PlatformCoreService;
  let admin: AuthenticatedPrincipal;
  let member: PrincipalEntity;

  const insertSession = async (principalId: string) => db.getRepository(SessionEntity).save({
    id: randomUUID(), principalId, tokenHash: randomUUID(), csrfHash: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000), revokedAt: null, replacedBySessionId: null,
  });

  beforeAll(async () => {
    db = createDataSource(databaseUrl);
    await db.initialize();
    const adminId = randomUUID();
    await db.getRepository(PrincipalEntity).save({
      id: adminId, realm: 'STAFF', username: `admin-${adminId}`, tenantId: null, passwordHash: randomUUID(),
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', mfaSecretCiphertext: null, lastTotpStep: null,
    });
    member = await db.getRepository(PrincipalEntity).save({
      id: randomUUID(), realm: 'STAFF', username: `member-${randomUUID()}`, tenantId: null, passwordHash: randomUUID(),
      role: 'MEMBER', status: 'ACTIVE', mfaSecretCiphertext: null, lastTotpStep: null,
    });
    admin = { id: adminId, realm: 'STAFF', username: 'admin', role: 'PLATFORM_ADMIN', tenantId: null, sessionId: randomUUID(), csrfToken: '' };
    core = new PlatformCoreService(db, {} as CoreEnv);
  });

  afterAll(async () => { await db?.destroy(); });

  it('lists only the caller sessions and revokes an owned session idempotently', async () => {
    const current = await insertSession(admin.id);
    const other = await insertSession(admin.id);
    const memberSession = await insertSession(member.id);
    admin.sessionId = current.id;
    const listed = await core.listOwnSessions(admin);
    expect(listed.some((row) => row.id === current.id && row.current && row.active)).toBe(true);
    expect(listed.some((row) => row.id === other.id)).toBe(true);
    expect(listed.some((row) => row.id !== current.id && row.id !== other.id)).toBe(false);
    await expect(core.revokeOwnSession(admin, memberSession.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(core.revokeOwnSession(admin, other.id, randomUUID())).resolves.toMatchObject({ current: false, revoked: true });
    await expect(core.revokeOwnSession(admin, other.id, randomUUID())).resolves.toMatchObject({ revoked: false });
  });

  it('prevents self-disable and atomically revokes every active staff session', async () => {
    await expect(core.disableStaffPrincipal(admin, admin.id, randomUUID())).rejects.toMatchObject({ status: 403 });
    await insertSession(member.id);
    await insertSession(member.id);
    const result = await core.disableStaffPrincipal(admin, member.id, randomUUID());
    expect(result.status).toBe('DISABLED');
    expect(result.revokedSessions).toBeGreaterThanOrEqual(2);
    expect((await db.getRepository(PrincipalEntity).findOneByOrFail({ id: member.id })).status).toBe('DISABLED');
    expect(await db.getRepository(SessionEntity).count({ where: { principalId: member.id, revokedAt: IsNull() } })).toBe(0);
    await insertSession(member.id);
    await expect(core.disableStaffPrincipal(admin, member.id, randomUUID())).resolves.toMatchObject({ revokedSessions: 1 });
    expect(await db.getRepository(SessionEntity).count({ where: { principalId: member.id, revokedAt: IsNull() } })).toBe(0);
  });

  it('does not take ownership of customer identity lifecycle', async () => {
    const customer = await db.getRepository(PrincipalEntity).save({
      id: randomUUID(), realm: 'CUSTOMER', username: `customer-${randomUUID()}`, tenantId: null, passwordHash: randomUUID(),
      role: 'MEMBER', status: 'ACTIVE', mfaSecretCiphertext: null, lastTotpStep: null,
    });
    await expect(core.disableStaffPrincipal(admin, customer.id, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect((await db.getRepository(PrincipalEntity).findOneByOrFail({ id: customer.id })).status).toBe('ACTIVE');
  });
});
