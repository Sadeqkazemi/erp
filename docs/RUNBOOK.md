# Runbook

- Health: `GET /health` returns `status: ok` only when the core database answers `SELECT 1`.
- Logs are structured JSON. Session cookies and authorization headers are redacted.
- Migrations: `npm run migration:run` with `DATABASE_URL` set to the migration role, not the runtime role.
- Rollback of this service is redeploy of the previous image. Do not restore this database over a newer domain database; the core database holds no orders or tickets.
- Production must set `COOKIE_SECURE=true` and must not set `ALLOW_TEST_BOOTSTRAP`.
