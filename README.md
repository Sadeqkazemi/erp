# BlueJet platform core

This repository holds the platform control plane from the 51-diagram target architecture, phase 1 foundation.

The core owns identity sessions, permission policy, the panel catalog, gateway route policy, the workflow engine runtime, audit, consent for optional cookies, and the transactional outbox. It does not store bookings, inventory, tickets, crew records, maintenance tasks, or financial ledgers.

Governing rules: `docs/BLUEJET_PLATFORM_RULES.md`.

## Local run

PostgreSQL 16+ is required. Create a database and two roles (runtime and migration) before production. For a local check:

```bash
cd backend
cp .env.example .env            # then set PANEL_TOKEN_PRIVATE_KEY
npm install
psql -v db=platform_core -v migration_password=... -v runtime_password=... -f scripts/provision-roles.sql
npm run migration:run           # uses DATABASE_MIGRATION_URL
npm run start                   # uses DATABASE_URL (runtime role)
```

Health: `GET /health`. API docs: `GET /docs` (not served in production). Panel token keys: `GET /.well-known/jwks.json`.

## Tests

```bash
cd backend
npm test
npm run lint
npm run typecheck
```

Set `PLATFORM_CORE_TEST_DATABASE_URL` (and optionally `PLATFORM_CORE_TEST_MIGRATION_DATABASE_URL`) to test against an existing database. Otherwise the end-to-end test starts a throwaway PostgreSQL cluster with `initdb` from `POSTGRES_BIN` (default `C:\Program Files\PostgreSQL\18\bin`).
