# Runbook

- Provision roles once per environment: `psql -v db=<db> -v migration_password=... -v runtime_password=... -f backend/scripts/provision-roles.sql`. Keep both passwords in the environment's secret store; never share them across environments.
- Migrations: `DATABASE_MIGRATION_URL=<migration role> npm run migration:run`. The service never runs migrations and refuses to start while any are pending.
- Health: `GET /health` returns `status: ok` only when the core database answers `SELECT 1`.
- Control plane diagnostics: platform admins may read `GET /v1/control-plane/summary`. The `outbox.oldestAgeSeconds` and `outbox.retried` fields help detect delivery lag; `domainSales=UNCONFIGURED` means no sales data source is connected. Do not infer sales or service availability from core counts.
- Logs are structured JSON. Session cookies and authorization headers are redacted. Unsafe `X-Request-Id` values are replaced.
- Panel token signing key: `PANEL_TOKEN_PRIVATE_KEY` (Ed25519). Services verify tokens with `GET /.well-known/jwks.json`. Rotating the key invalidates outstanding panel tokens (they live at most `PANEL_TOKEN_TTL_SECONDS`).
- Rollback of this service is redeploy of the previous image. Do not restore this database over a newer domain database; the core database holds no orders or tickets.
- Production must set `COOKIE_SECURE=true`, https `ALLOWED_ORIGINS`, and must not set `ALLOW_TEST_BOOTSTRAP` or `EXPOSE_API_DOCS`; startup fails otherwise.
# Outbox delivery

Set `OUTBOX_PUBLISH_URL` to an internal HTTPS broker ingress and store `OUTBOX_PUBLISH_TOKEN` in the secret store. Production startup rejects missing settings. The ingress must return 2xx only after durable acceptance, use `Idempotency-Key`/`eventId` to deduplicate, and reject unavailable broker writes with a non-2xx response. The core retries unacknowledged rows every five seconds. Inspect `outbox_events` where `publishedAt` is null and monitor the oldest `createdAt` plus attempts and lastError. If ingress is down, restore it and allow normal retries; do not manually set `publishedAt`. A broker acknowledgment followed by a core transaction rollback may produce a duplicate, so consumers must also deduplicate on eventId. Long outages require operator review and a dead-letter/alert integration before production rollout.
