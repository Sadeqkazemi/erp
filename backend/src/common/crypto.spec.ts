import { generateKeyPairSync } from 'crypto';
import {
  generateTotpSecret,
  loadPanelTokenKeys,
  sessionCookiePolicy,
  signPanelToken,
  totpCode,
  totpStep,
  verifyPanelToken,
  verifyTotp,
} from './crypto';

describe('session cookie policy', () => {
  it('uses a host-only secure cookie when TLS is required', () => {
    const policy = sessionCookiePolicy(true);
    expect(policy).toEqual({
      name: '__Host-bj_session',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(policy).not.toHaveProperty('domain');
  });
});

describe('totp', () => {
  it('returns the matched step so a caller can reject reuse', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(totpStep(now));
    expect(verifyTotp(secret, '000000x', now)).toBeNull();
  });
});

describe('panel tokens', () => {
  const pem = (): string => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const now = 1_800_000_000;

  it('verifies an Ed25519 token only with the right key, issuer and expiry', () => {
    const keys = loadPanelTokenKeys(pem());
    const token = signPanelToken({ iss: 'core', sub: 'u1', aud: 'panel:crew', exp: now + 60 }, keys);
    expect(verifyPanelToken(token, keys, { issuer: 'core', nowSeconds: now }).aud).toBe('panel:crew');
    expect(() => verifyPanelToken(token, keys, { issuer: 'other', nowSeconds: now })).toThrow('wrong issuer');
    expect(() => verifyPanelToken(token, keys, { issuer: 'core', nowSeconds: now + 61 })).toThrow('expired');
    expect(() => verifyPanelToken(token, loadPanelTokenKeys(pem()), { issuer: 'core', nowSeconds: now })).toThrow();
  });

  it('rejects a non-Ed25519 signing key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => loadPanelTokenKeys(rsa)).toThrow('Ed25519');
  });
});
