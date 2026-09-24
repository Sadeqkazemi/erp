export const CORE_ENV = Symbol('CORE_ENV');

export interface CoreEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  panelTokenTtlSeconds: number;
  jwtSecret: string;
  mfaEncryptionKey: Buffer;
  allowedOrigins: string[];
  allowTestBootstrap: boolean;
}

function parseBoolean(source: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = source[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): CoreEnv {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const allowTestBootstrap = parseBoolean(source, 'ALLOW_TEST_BOOTSTRAP', false);
  if (nodeEnv === 'production' && allowTestBootstrap) {
    throw new Error('ALLOW_TEST_BOOTSTRAP cannot be enabled in production');
  }
  const cookieSecure = parseBoolean(source, 'COOKIE_SECURE', nodeEnv === 'production');
  if (nodeEnv === 'production' && !cookieSecure) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  const keyHex = requiredFrom(source, 'MFA_ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes of hex');
  }
  const jwtSecret = requiredFrom(source, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  const origins = requiredFrom(source, 'ALLOWED_ORIGINS')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    nodeEnv,
    port: Number(source.PORT ?? '3000'),
    databaseUrl: requiredFrom(source, 'DATABASE_URL'),
    cookieSecure,
    sessionTtlSeconds: Number(source.SESSION_TTL_SECONDS ?? '900'),
    panelTokenTtlSeconds: Number(source.PANEL_TOKEN_TTL_SECONDS ?? '300'),
    jwtSecret,
    mfaEncryptionKey: Buffer.from(keyHex, 'hex'),
    allowedOrigins: origins,
    allowTestBootstrap,
  };
}

function requiredFrom(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function assertProductionSafe(env: CoreEnv): void {
  if (env.nodeEnv !== 'production') {
    return;
  }
  if (!env.cookieSecure || env.allowTestBootstrap) {
    throw new Error('Production cookie and bootstrap flags are unsafe');
  }
}
