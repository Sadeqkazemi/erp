# BlueJet platform registry service

First independently deployable control-plane slice from BlueJet Platform Rules v1.1 and architecture views 41–44 and 50. Owner: Platform Engineering. This service owns panel catalog metadata only. It does not own bookings, PNRs, payment, crew, maintenance or finance data. Consumers: internal management, operations and employee channels through the gateway.

## Contract and privacy

See `../contracts/platform-registry.openapi.yaml`. Input is platform configuration, no passenger or crew PII. Responses include only the caller's verified tenant. Time is UTC; there are no monetary values. `GET` needs `panel.read`; `POST` needs both `panel.write` and `platform-admin`. A signed RS256 OIDC token must match configured issuer and audience and have unexpired `exp`, tenant ID and subject. The gateway must independently authenticate and rate limit; the service still validates authorization. No browser cookie is accepted.

`POST` requires an idempotency key. The panel row, receipt and audit event commit in one PostgreSQL transaction. Exact replay returns 200; different payload under the same key returns 409. Only the tenant owning a panel can list it. Site Admin is always in Employees. Errors have stable codes and a request ID. The runtime DB user should receive SELECT and INSERT on these tables only, with no DELETE or UPDATE to `panel_audit`; migration credentials are separate.

## Local validation

`node --test test/*.test.mjs` runs domain, authorization and HTTP contract tests without a database. To run the service, install locked dependencies in an isolated development environment, apply `migrations/001_panel_registry.sql` with a migration-only account, provide the variables in `.env.example` from a secret manager, then `npm start`. Do not commit `.env` or enable this API publicly before identity, gateway, backups and operations checks are ready.

## Rollout and limits

No Production deployment is authorized by this source change. This initial service is not yet connected to the hosted panel or the older `blujet2` shared backend. PostgreSQL migration execution, real identity integration, cross-tenant integration tests, restore proof, telemetry, on-call targets and UAT remain required. Start with read-only gateway routing in isolated UAT, then test registration, duplicate requests and failure recovery. Rollback routes traffic to the existing preview; preserve any committed registry/audit rows and do not delete the database. Never move PSS or sales ownership as part of this rollout.
