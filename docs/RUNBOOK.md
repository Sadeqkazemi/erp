# Runbook

- Provision roles once per environment: `psql -v db=<db> -v migration_password=... -v runtime_password=... -f backend/scripts/provision-roles.sql`. Keep both passwords in the environment's secret store; never share them across environments.
- Migrations: `DATABASE_MIGRATION_URL=<migration role> npm run migration:run`. The service never runs migrations and refuses to start while any are pending.
- Health: `GET /health` returns `status: ok` only when the core database answers `SELECT 1`.
- Logs are structured JSON. Session cookies and authorization headers are redacted. Unsafe `X-Request-Id` values are replaced.
- Panel token signing key: `PANEL_TOKEN_PRIVATE_KEY` (Ed25519). Services verify tokens with `GET /.well-known/jwks.json`. Rotating the key invalidates outstanding panel tokens (they live at most `PANEL_TOKEN_TTL_SECONDS`).
- Rollback of this service is redeploy of the previous image. Do not restore this database over a newer domain database; the core database holds no orders or tickets.
- Production must set `COOKIE_SECURE=true`, https `ALLOWED_ORIGINS`, and must not set `ALLOW_TEST_BOOTSTRAP` or `EXPOSE_API_DOCS`; startup fails otherwise.
