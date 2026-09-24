import { nextOutboxRetryAt, OUTBOX_MAX_ATTEMPTS } from './retry-policy';

describe('outbox retry policy', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('backs off repeated failures and caps delay', () => {
    expect(nextOutboxRetryAt(1, now)?.toISOString()).toBe('2026-01-01T00:00:10.000Z');
    expect(nextOutboxRetryAt(2, now)?.toISOString()).toBe('2026-01-01T00:00:20.000Z');
    expect(nextOutboxRetryAt(7, now)?.toISOString()).toBe('2026-01-01T00:10:40.000Z');
  });

  it('stops dispatch after repeated failures until an operator requeues', () => {
    expect(nextOutboxRetryAt(OUTBOX_MAX_ATTEMPTS, now)).toBeNull();
  });
});
