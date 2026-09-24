import 'reflect-metadata';
import { generateKeyPairSync } from 'crypto';
import { DataSource } from 'typeorm';
import { loadPanelTokenKeys, signPanelToken } from '../common/crypto';
import { CoreEnv } from '../config/env';
import { EntitlementEntity, PanelEntity, PrincipalEntity, RouteContractEntity, SessionEntity } from '../database/entities';
import { PlatformCoreService } from './platform-core.service';

describe('gateway decision after entitlement changes', () => {
  const principalId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const panelId = '33333333-3333-4333-8333-333333333333';
  const keys = loadPanelTokenKeys(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const now = Math.floor(Date.now() / 1000);
  const bearer = `Bearer ${signPanelToken({
    iss: 'bluejet-platform-core', sub: principalId, sid: sessionId, panelId,
    aud: 'panel:crew', realm: 'STAFF', iat: now, exp: now + 300,
  }, keys)}`;
  const session = { id: sessionId, principalId, revokedAt: null, expiresAt: new Date(Date.now() + 300000) };
  const principal = { id: principalId, status: 'ACTIVE', realm: 'STAFF' };
  const route = { method: 'GET', pathPattern: '/v1/crew/roster', audience: 'panel:crew', allowedRealms: 'STAFF', upstreamBaseUrl: 'https://crew.internal', timeoutMs: 100, version: 'v1' };
  const panel = { id: panelId, audience: 'panel:crew', status: 'ACTIVE' };
  const entitlement = { id: '44444444-4444-4444-8444-444444444444', principalId, panelId, status: 'ACTIVE' };
  const records = new Map<unknown, unknown>([
    [SessionEntity, session], [PrincipalEntity, principal], [RouteContractEntity, route],
    [PanelEntity, panel], [EntitlementEntity, entitlement],
  ]);
  const findOne = jest.fn((entity: unknown, where: Record<string, unknown>) => {
    const record = records.get(entity) as Record<string, unknown> | undefined;
    return Promise.resolve(record && Object.entries(where).every(([key, value]) => record[key] === value) ? record : null);
  });
  const db = { getRepository: (entity: unknown) => ({ findOne: (options: { where: Record<string, unknown> }) => findOne(entity, options.where) }) } as unknown as DataSource;
  const service = new PlatformCoreService(db, { panelTokenKeys: keys, panelTokenIssuer: 'bluejet-platform-core' } as CoreEnv);
  const decision = () => service.decideRoute(bearer, { method: 'GET', pathPattern: '/v1/crew/roster', version: 'v1' });

  afterEach(() => {
    records.set(PrincipalEntity, principal);
    records.set(EntitlementEntity, entitlement);
  });

  it('permits an active panel entitlement', async () => {
    await expect(decision()).resolves.toMatchObject({ audience: 'panel:crew' });
  });

  it('rejects an already-issued token when its entitlement is revoked', async () => {
    records.set(EntitlementEntity, { ...entitlement, status: 'REVOKED' });
    await expect(decision()).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a token after its principal is disabled', async () => {
    records.set(PrincipalEntity, { ...principal, status: 'DISABLED' });
    await expect(decision()).rejects.toMatchObject({ status: 401 });
  });
});
