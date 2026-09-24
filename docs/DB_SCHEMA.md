# Platform core schema

One PostgreSQL database for the control plane. Two roles, created by `backend/scripts/provision-roles.sql`: `core_migration` owns the schema and runs migrations; `core_runtime` has only SELECT, INSERT and UPDATE on tables, with no DDL, DELETE or TRUNCATE. Neither role is a superuser or has grants on any domain database.

Tables:

- `principals` — realm (`STAFF`, `CUSTOMER`, `AGENCY`, `WORKLOAD`), username unique per realm, Argon2id password hash, encrypted TOTP secret for staff, role, last accepted TOTP step (replay guard)
- `sessions` — hashed session token, hashed CSRF secret, expiry, revocation, replacement
- `panels` — code (checked slug), owner service, classification, Persian and English titles, token audience, constrained status
- `entitlements` — staff principal, panel, granting admin. Unique per principal and panel
- `route_contracts` — method (constrained), path, upstream base URL, audience, timeout (50–5000 ms), allowed realms, version. Unique per method, path and version
- `service_operational_profiles` — append-only, versioned service owner/on-call/runbook and service-specific availability, p95 latency, RTO and RPO targets. Unique per owner service and version; publication records the platform admin
- `workflow_runs` — definition key, owning service, correlation id, engine status (constrained), starter, version, idempotency key unique per starter. No business payload
- `audit_events` — actor, action, object, correlation id. A trigger rejects UPDATE, DELETE and TRUNCATE
- `outbox_events` — event id, name, aggregate id, payload, `publishedAt`, attempts, last error. Dispatch claims rows with `FOR UPDATE SKIP LOCKED`
- `consent_records` — purpose `ANALYTICS` or `ADVERTISING`, policy version, decision, timestamp
- `visitor_consents` — anonymous visitor cookie hash, purpose, policy version, grant or withdrawal and UTC timestamp. The raw cookie is never stored; missing cookies default to no optional purposes. Add retention and policy-version handling before production integration.

Agency principals carry `tenantId` (UUID); staff and customers remain outside agency tenants. Agency usernames are unique within their tenant. Existing agency identities with no verified tenant mapping cannot authenticate after this migration; map them from an authoritative agency registry, then validate the agency constraint. Audit events carry the actor's tenant ID. This is a foundation for tenant policy; domain services must independently enforce tenant and object permissions. Do not assign tenant IDs by guessing from usernames.

`workflow_steps` records an engine step key, status, attempt and UTC deadline under `workflow_runs`. Uniqueness is per run and step key. The timer records expiry in the same transaction as audit and outbox events; it does not call a business service or claim a business action was undone. Manual compensation status must reflect an actual owning-service operation and evidence before production use.

`outbox_events` also tracks `nextAttemptAt` and `deadLetterAt`. Failures use bounded exponential retry; after eight failed attempts the row is halted and remains durable for operator investigation. Replay preserves `eventId` for consumer deduplication and emits an audit/outbox control event.
- `idempotency_records` — principal, scope (operation), key, request hash, stored response. Unique per principal, scope and key

No booking, inventory, ticket, payment, crew, or maintenance tables.
# Workflow definition registry (migration 0006)

`workflow_definitions` stores an immutable key such as `operations.recovery.v1`, the owner service and an ordered JSON array of 1–32 `{stepKey, timeoutSeconds}` entries. Runtime validates unique keys and bounds before insert; the database enforces key uniqueness and a nonempty array. Existing runs remain unchanged. Register approved definitions before switching on production traffic; do not backfill invented owners or steps from historical runs. The migration adds a table and can be rolled back only after verifying no definitions require retention.

# Service observations (migration 0007)

`service_observations` is append-only operational evidence for a registered gateway route. A manual admin probe records route ID, `UP`/`DOWN`, HTTP status when available, bounded latency, failure category, `MANUAL_PROBE` source and UTC observation time. It stores no response body or business record. The service catalog treats observations older than five minutes, or an incomplete route set, as stale rather than live health. The database rejects update, delete and truncate; retention/partitioning must be approved before production volume grows.

# Service operational profiles (migration 0008)

`service_operational_profiles` records each explicit operational contract as a new immutable version. Publication uses an advisory lock plus `expectedCurrentVersion`, so concurrent administrators cannot silently overwrite each other. Availability uses integer basis points, latency uses milliseconds, and RTO/RPO use minutes. The profile contains routing aliases and an HTTPS runbook URL, not credentials. Existing services remain honestly `UNCONFIGURED` until their accountable owner approves and publishes values; the migration does not fabricate targets.
