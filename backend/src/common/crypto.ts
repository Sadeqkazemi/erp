import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  JsonWebKey,
  KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-bj_session' : 'bj_session';
}

export function csrfCookieName(secure: boolean): string {
  return secure ? '__Host-bj_csrf' : 'bj_csrf';
}

export interface SessionCookiePolicy {
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
}

export function sessionCookiePolicy(secure: boolean): SessionCookiePolicy {
  return {
    name: sessionCookieName(secure),
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}

function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) {
      throw new Error('invalid base32');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, at: Date, stepSeconds = 30): string {
  const counter = totpStep(at, stepSeconds);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export function totpStep(at: Date, stepSeconds = 30): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

/**
 * Returns the matched time step so callers can reject reuse of the same code,
 * or null when the code does not match the current step or one step either side.
 */
export function verifyTotp(secret: string, code: string, at: Date): number | null {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return null;
  }
  for (const skew of [-30_000, 0, 30_000]) {
    const when = new Date(at.getTime() + skew);
    const a = Buffer.from(totpCode(secret, when));
    const b = Buffer.from(trimmed);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return totpStep(when);
    }
  }
  return null;
}

export interface PanelTokenKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

export interface WorkloadTokenVerifier {
  keys: Map<string, KeyObject>;
  issuer: string;
  audience: string;
  maxTtlSeconds: number;
}

export function loadPanelTokenKeys(privateKeyPem: string): PanelTokenKeys {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('PANEL_TOKEN_PRIVATE_KEY must be an Ed25519 private key');
  }
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
  return { privateKey, publicKey, kid };
}

export function panelTokenJwks(keys: PanelTokenKeys): { keys: Record<string, unknown>[] } {
  const jwk = keys.publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: keys.kid, alg: 'EdDSA', use: 'sig' }] };
}

export function signPanelToken(payload: Record<string, string | number>, keys: PanelTokenKeys): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keys.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyPanelToken(
  token: string,
  keys: PanelTokenKeys,
  expected: { issuer: string; nowSeconds: number },
): Record<string, string | number> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed token');
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
  if (header.alg !== 'EdDSA' || header.kid !== keys.kid) {
    throw new Error('unexpected token header');
  }
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), keys.publicKey, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('bad signature');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, string | number>;
  if (payload.iss !== expected.issuer) {
    throw new Error('wrong issuer');
  }
  const exp = payload.exp;
  if (typeof exp !== 'number' || exp <= expected.nowSeconds) {
    throw new Error('expired');
  }
  return payload;
}

export function loadWorkloadTokenVerifier(
  jwksJson: string, issuer: string, audience: string, maxTtlSeconds: number,
): WorkloadTokenVerifier {
  if (!issuer || !audience || !Number.isInteger(maxTtlSeconds) || maxTtlSeconds < 30 || maxTtlSeconds > 900) {
    throw new Error('Workload token issuer, audience and max TTL are invalid');
  }
  const parsed = JSON.parse(jwksJson) as { keys?: unknown };
  if (!Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 10) {
    throw new Error('WORKLOAD_JWKS_JSON must contain 1 to 10 public keys');
  }
  const keys = new Map<string, KeyObject>();
  for (const value of parsed.keys) {
    const jwk = value as Record<string, unknown>;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.alg !== 'EdDSA' || jwk.use !== 'sig' ||
      typeof jwk.kid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(jwk.kid) || 'd' in jwk) {
      throw new Error('WORKLOAD_JWKS_JSON accepts public Ed25519 signing keys only');
    }
    if (keys.has(jwk.kid)) throw new Error('WORKLOAD_JWKS_JSON contains a duplicate kid');
    keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
  }
  return { keys, issuer, audience, maxTtlSeconds };
}

export function verifyWorkloadToken(
  token: string, verifier: WorkloadTokenVerifier, nowSeconds: number,
): { sub: string; service: string; jti: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
  const key = typeof header.kid === 'string' ? verifier.keys.get(header.kid) : null;
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || !key) throw new Error('unexpected token header');
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('bad signature');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  const exp = payload.exp;
  const iat = payload.iat;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (payload.iss !== verifier.issuer || payload.aud !== verifier.audience || !Number.isInteger(exp) ||
    !Number.isInteger(iat) || (payload.nbf !== undefined && !Number.isInteger(payload.nbf)) ||
    (exp as number) <= nowSeconds || (iat as number) > nowSeconds + 30 ||
    (exp as number) - (iat as number) <= 0 || (exp as number) - (iat as number) > verifier.maxTtlSeconds ||
    (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 30) ||
    typeof payload.sub !== 'string' || !uuid.test(payload.sub) ||
    typeof payload.service !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(payload.service) ||
    typeof payload.jti !== 'string' || !uuid.test(payload.jti)) {
    throw new Error('invalid workload claims');
  }
  return { sub: payload.sub, service: payload.service, jti: payload.jti };
}
