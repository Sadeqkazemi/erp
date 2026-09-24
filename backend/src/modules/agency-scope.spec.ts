import { DataSource } from 'typeorm';
import { CoreEnv } from '../config/env';
import { PlatformCoreService } from './platform-core.service';

describe('agency identity scope', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const repository = { findOne: jest.fn().mockResolvedValue(null) };
  const db = { getRepository: jest.fn().mockReturnValue(repository) } as unknown as DataSource;
  const service = new PlatformCoreService(db, {} as CoreEnv);

  it('rejects an agency principal created without an explicit tenant', async () => {
    await expect(service.createPrincipal({ realm: 'AGENCY', username: 'agent', password: '', role: 'MEMBER' }))
      .rejects.toThrow();
    expect(db.getRepository).not.toHaveBeenCalled();
  });

  it('rejects agency login without a tenant before looking up a username', async () => {
    await expect(service.login({ realm: 'AGENCY', username: 'agent', password: '' })).rejects.toThrow();
    expect(db.getRepository).not.toHaveBeenCalled();
  });

  it('looks up an agency principal only in the requested tenant', async () => {
    await expect(service.login({ realm: 'AGENCY', tenantId, username: 'agent', password: '' })).rejects.toThrow();
    expect(repository.findOne).toHaveBeenCalledWith({ where: {
      realm: 'AGENCY', username: 'agent', status: 'ACTIVE', tenantId,
    } });
  });
});
