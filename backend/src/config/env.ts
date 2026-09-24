import { loadPanelTokenKeys, loadWorkloadTokenVerifier, PanelTokenKeys, WorkloadTokenVerifier } from '../common/crypto';

export const CORE_ENV = Symbol('CORE_ENV');

export interface CoreEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  panelTokenTtlSeconds: number;
  panelTokenIssuer: string;
  panelTokenKeys: PanelTokenKeys;
  mfaEncryptionKey: Buffer;
  allowedOrigins: string[];
  allowTestBootstrap: boolean;
  exposeApiDocs: boolean;
  outboxPublishUrl: string | null;
  outboxPublishToken: string | null;
  workflowDefinitionsRequired: boolean;
  gatewayAllowedHosts: string[];
  gatewayMaxRequestBytes: number;
  gatewayMaxResponseBytes: number;
  workloadTokenVerifier: WorkloadTokenVerifier | null;
  metricsBearerToken: string | null;
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

function parsePositiveInt(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): CoreEnv {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const allowTestBootstrap = parseBoolean(source, 'ALLOW_TEST_BOOTSTRAP', false);
  if (production && allowTestBootstrap) {
    throw new Error('ALLOW_TEST_BOOTSTRAP cannot be enabled in production');
  }
  const cookieSecure = parseBoolean(source, 'COOKIE_SECURE', production);
  if (production && !cookieSecure) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  const exposeApiDocs = parseBoolean(source, 'EXPOSE_API_DOCS', !production);
  if (production && exposeApiDocs) {
    throw new Error('EXPOSE_API_DOCS cannot be enabled in production');
  }
  const keyHex = requiredFrom(source, 'MFA_ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes of hex');
  }
  // Secret stores often hold PEM on one line with literal \n separators.
  const panelTokenKeys = loadPanelTokenKeys(requiredFrom(source, 'PANEL_TOKEN_PRIVATE_KEY').replace(/\\n/g, '\n'));
  const origins = requiredFrom(source, 'ALLOWED_ORIGINS')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (production && origins.some((origin) => !origin.startsWith('https://'))) {
    throw new Error('ALLOWED_ORIGINS must use https in production');
  }
  const outboxPublishUrl = source.OUTBOX_PUBLISH_URL?.trim() || null;
  const outboxPublishToken = source.OUTBOX_PUBLISH_TOKEN?.trim() || null;
  if (outboxPublishUrl && (!/^https?:\/\//.test(outboxPublishUrl) || (production && !outboxPublishUrl.startsWith('https://')))) {
    throw new Error('OUTBOX_PUBLISH_URL must be an HTTP endpoint (HTTPS in production)');
  }
  if (production && (!outboxPublishUrl || !outboxPublishToken)) {
    throw new Error('OUTBOX_PUBLISH_URL and OUTBOX_PUBLISH_TOKEN are required in production');
  }
  const gatewayAllowedHosts = (source.GATEWAY_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (gatewayAllowedHosts.some((host) => !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))) {
    throw new Error('GATEWAY_ALLOWED_HOSTS must contain exact host or host:port values');
  }
  if (production && gatewayAllowedHosts.length === 0) {
    throw new Error('GATEWAY_ALLOWED_HOSTS is required in production');
  }
  const workloadJwks = source.WORKLOAD_JWKS_JSON?.trim() || null;
  const workloadIssuer = source.WORKLOAD_TOKEN_ISSUER?.trim() || null;
  const workloadAudience = source.WORKLOAD_TOKEN_AUDIENCE?.trim() || null;
  const workloadSettings = [workloadJwks, workloadIssuer, workloadAudience];
  if (workloadSettings.some(Boolean) && !workloadSettings.every(Boolean)) {
    throw new Error('WORKLOAD_JWKS_JSON, WORKLOAD_TOKEN_ISSUER and WORKLOAD_TOKEN_AUDIENCE must be configured together');
  }
  if (production && (!workloadJwks || !workloadIssuer || !workloadAudience)) {
    throw new Error('WORKLOAD_JWKS_JSON, WORKLOAD_TOKEN_ISSUER and WORKLOAD_TOKEN_AUDIENCE are required in production');
  }
  const workloadMaxTtl = parsePositiveInt(source, 'WORKLOAD_TOKEN_MAX_TTL_SECONDS', 300);
  if (workloadMaxTtl < 30 || workloadMaxTtl > 900) {
    throw new Error('WORKLOAD_TOKEN_MAX_TTL_SECONDS must be between 30 and 900');
  }
  const workloadTokenVerifier = workloadJwks && workloadIssuer && workloadAudience
    ? loadWorkloadTokenVerifier(workloadJwks, workloadIssuer, workloadAudience, workloadMaxTtl)
    : null;
  const metricsBearerToken = source.METRICS_BEARER_TOKEN?.trim() || null;
  if (metricsBearerToken && metricsBearerToken.length < 32) {
    throw new Error('METRICS_BEARER_TOKEN must contain at least 32 characters');
  }
  if (production && !metricsBearerToken) {
    throw new Error('METRICS_BEARER_TOKEN is required in production');
  }
  return {
    nodeEnv,
    port: parsePositiveInt(source, 'PORT', 3000),
    databaseUrl: requiredFrom(source, 'DATABASE_URL'),
    cookieSecure,
    sessionTtlSeconds: parsePositiveInt(source, 'SESSION_TTL_SECONDS', 900),
    panelTokenTtlSeconds: parsePositiveInt(source, 'PANEL_TOKEN_TTL_SECONDS', 300),
    panelTokenIssuer: source.PANEL_TOKEN_ISSUER ?? 'bluejet-platform-core',
    panelTokenKeys,
    mfaEncryptionKey: Buffer.from(keyHex, 'hex'),
    allowedOrigins: origins,
    allowTestBootstrap,
    exposeApiDocs,
    outboxPublishUrl,
    outboxPublishToken,
    workflowDefinitionsRequired: production,
    gatewayAllowedHosts,
    gatewayMaxRequestBytes: parsePositiveInt(source, 'GATEWAY_MAX_REQUEST_BYTES', 262_144),
    gatewayMaxResponseBytes: parsePositiveInt(source, 'GATEWAY_MAX_RESPONSE_BYTES', 1_048_576),
    workloadTokenVerifier,
    metricsBearerToken,
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
  if (!env.cookieSecure || env.allowTestBootstrap || env.exposeApiDocs || env.gatewayAllowedHosts.length === 0 ||
    !env.metricsBearerToken) {
    throw new Error('Production cookie, bootstrap and API docs flags are unsafe');
  }
}
