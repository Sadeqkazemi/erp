export const OUTBOX_MAX_ATTEMPTS = 8;

export function nextOutboxRetryAt(attempts: number, now: Date): Date | null {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return null;
  const seconds = Math.min(3600, 10 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + seconds * 1000);
}
