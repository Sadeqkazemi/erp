import { generateKeyPairSync } from 'crypto';
import { loadPanelTokenKeys, panelTokenJwks } from '../common/crypto';
import { loadEnv } from './env';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test@127.0.0.1/test',
    COOKIE_SECURE: 'false',
    PANEL_TOKEN_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString(),
    MFA_ENCRYPTION_KEY: '11'.repeat(32),
    ALLOWED_ORIGINS: 'http://localhost:5173',
  };
}

describe('workload identity environment', () => {
  it('loads a public Ed25519 verifier only when the complete contract is present', () => {
    const source = baseEnv();
    const keys = loadPanelTokenKeys(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    source.WORKLOAD_JWKS_JSON = JSON.stringify(panelTokenJwks(keys));
    source.WORKLOAD_TOKEN_ISSUER = 'https://identity.test';
    source.WORKLOAD_TOKEN_AUDIENCE = 'bluejet-platform-core';
    source.WORKLOAD_TOKEN_MAX_TTL_SECONDS = '120';
    expect(loadEnv(source).workloadTokenVerifier).toEqual(expect.objectContaining({
      issuer: 'https://identity.test', audience: 'bluejet-platform-core', maxTtlSeconds: 120,
    }));
  });

  it('fails on a partial workload contract or an excessive token lifetime', () => {
    const partial = baseEnv();
    partial.WORKLOAD_TOKEN_ISSUER = 'https://identity.test';
    expect(() => loadEnv(partial)).toThrow('must be configured together');

    const excessive = baseEnv();
    excessive.WORKLOAD_TOKEN_MAX_TTL_SECONDS = '901';
    expect(() => loadEnv(excessive)).toThrow('between 30 and 900');
  });
});
