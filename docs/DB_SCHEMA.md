# Platform core schema

One PostgreSQL database for the control plane. Runtime credentials must not be superuser and must not be granted on any domain database.

Tables:

- `principals` — realm (`STAFF`, `CUSTOMER`, `AGENCY`, `WORKLOAD`), username unique per realm, password hash, encrypted TOTP secret for staff, role
- `sessions` — hashed session token, hashed CSRF secret, expiry, revocation, replacement
- `panels` — code, owner service, classification, Persian and English titles, token audience
- `entitlements` — staff principal, panel, granting admin. Unique per principal and panel
- `route_contracts` — method, path, upstream base URL, audience, timeout, allowed realms, version
- `workflow_runs` — definition key, owning service, correlation id, engine status, idempotency key. No business payload
- `audit_events` — append-only actor, action, object, correlation id
- `outbox_events` — event id, name, aggregate id, payload, `publishedAt`
- `consent_records` — purpose `ANALYTICS` or `ADVERTISING`, policy version, decision, timestamp
- `idempotency_records` — key, request hash, stored response

No booking, inventory, ticket, payment, crew, or maintenance tables.
