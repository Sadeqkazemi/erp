# BlueJet platform core

This repository holds the platform control plane from the 51-diagram target architecture, phase 1 foundation.

The core owns identity sessions, permission policy, the panel catalog, gateway route policy, the workflow engine runtime, audit, consent for optional cookies, and the transactional outbox. It does not store bookings, inventory, tickets, crew records, maintenance tasks, or financial ledgers.

Governing rules: `docs/BLUEJET_PLATFORM_RULES.md`.

## Local run

PostgreSQL 16+ is required. Create a database and two roles (runtime and migration) before production. For a local check:

```bash
cd backend
cp .env.example .env
npm install
npm run migration:run
npm run start
```

Health: `GET /health`. API docs: `GET /docs`.

## Tests

```bash
cd backend
npm test
npm run lint
npm run typecheck
```

On Windows the end-to-end test starts a throwaway PostgreSQL cluster with the local `initdb` at `POSTGRES_BIN` (default `C:\Program Files\PostgreSQL\18\bin`).
