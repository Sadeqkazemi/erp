import { randomUUID } from 'crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a caller-supplied correlation id only when it is safe to log; otherwise mints one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}
