import { DataSource } from 'typeorm';
import { CoreEnv } from '../config/env';
import { PlatformCoreService } from './platform-core.service';

describe('anonymous consent', () => {
  const token = 'a'.repeat(43);
  const rows = [
    { purpose: 'ANALYTICS', decision: 'WITHDRAWN', recordedAt: new Date('2026-01-02') },
    { purpose: 'ANALYTICS', decision: 'GRANTED', recordedAt: new Date('2026-01-01') },
    { purpose: 'ADVERTISING', decision: 'GRANTED', recordedAt: new Date('2026-01-01') },
  ];
  const repository = { find: jest.fn().mockResolvedValue(rows) };
  const db = { getRepository: jest.fn().mockReturnValue(repository) } as unknown as DataSource;
  const service = new PlatformCoreService(db, {} as CoreEnv);

  it('defaults both optional purposes to off without a visitor cookie', async () => {
    await expect(service.visitorConsentSnapshot(undefined)).resolves.toEqual({ analytics: false, advertising: false });
    expect(db.getRepository).not.toHaveBeenCalled();
  });

  it('uses the latest withdrawal and never queries with the raw cookie', async () => {
    await expect(service.visitorConsentSnapshot(token)).resolves.toEqual({ analytics: false, advertising: true });
    expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { visitorHash: expect.not.stringMatching(token) },
    }));
  });
});
