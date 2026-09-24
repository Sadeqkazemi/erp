# Platform core schema

One PostgreSQL database for the control plane. Two roles, created by `backend/scripts/provision-roles.sql`: `core_migration` owns the schema and runs migrations; `core_runtime` has only SELECT, INSERT and UPDATE on tables, with no DDL, DELETE or TRUNCATE. Neither role is a superuser or has grants on any domain database.

Tables:

- `principals` — realm (`STAFF`, `CUSTOMER`, `AGENCY`, `WORKLOAD`), username unique per realm, Argon2id password hash, encrypted TOTP secret for staff, role, last accepted TOTP step (replay guard)
- `sessions` — hashed session token, hashed CSRF secret, expiry, revocation, replacement
- `panels` — code (checked slug), owner service, classification, Persian and English titles, token audience, constrained status
- `entitlements` — staff principal, panel, granting admin. Unique per principal and panel
- `route_contracts` — method (constrained), path, upstream base URL, audience, timeout (50–5000 ms), allowed realms, version. Unique per method, path and version
- `workflow_runs` — definition key, owning service, correlation id, engine status (constrained), starter, version, idempotency key unique per starter. No business payload
- `audit_events` — actor, action, object, correlation id. A trigger rejects UPDATE, DELETE and TRUNCATE
- `outbox_events` — event id, name, aggregate id, payload, `publishedAt`, attempts, last error. Dispatch claims rows with `FOR UPDATE SKIP LOCKED`
- `consent_records` — purpose `ANALYTICS` or `ADVERTISING`, policy version, decision, timestamp
- `visitor_consents` — anonymous visitor cookie hash, purpose, policy version, grant or withdrawal and UTC timestamp. The raw cookie is never stored; missing cookies default to no optional purposes. Add retention and policy-version handling before production integration.
- `idempotency_records` — principal, scope (operation), key, request hash, stored response. Unique per principal, scope and key

No booking, inventory, ticket, payment, crew, or maintenance tables.
