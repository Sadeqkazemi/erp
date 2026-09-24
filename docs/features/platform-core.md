# Platform core foundation

- [x] Host-only session cookie policy — `src/common/crypto.spec.ts`
- [x] Staff login without TOTP is rejected — `test/platform-core.e2e-spec.ts` rejects a staff login without the second factor
- [x] Launcher is empty until a real entitlement exists — `test/platform-core.e2e-spec.ts` returns an empty launcher
- [x] Self-grant is forbidden — `test/platform-core.e2e-spec.ts` blocks self-grant
- [x] Customer identity cannot receive a staff panel — `test/platform-core.e2e-spec.ts` blocks customer entitlements
- [x] Panel token audience is enforced by the gateway — `test/platform-core.e2e-spec.ts` blocks cross-panel tokens
- [x] CSRF rejection — `test/platform-core.e2e-spec.ts` missing CSRF
- [x] Upstream timeout does not take down core health — `test/platform-core.e2e-spec.ts` probe
- [x] Session rotation invalidates the old cookie — `test/platform-core.e2e-spec.ts` rotates the session
- [x] Optional consent defaults off and withdrawal wins — `test/platform-core.e2e-spec.ts` records consent withdrawal
- [x] Illegal workflow transition is rejected — `src/modules/workflow/workflow-transitions.spec.ts` and e2e
- [x] Outbox dispatch uses an idempotency key per event — `test/platform-core.e2e-spec.ts` checks accepted events

## Hardening (review findings)

- [x] Concurrent workflow transitions are serialised; a terminal state cannot be overwritten — e2e `serialises concurrent workflow transitions`
- [x] Only the starter or a platform admin may transition a run — e2e `lets only the starter or a platform admin`
- [x] Idempotency keys are scoped per caller and operation; concurrent retries create one record — e2e `scopes idempotency keys`, `registers one panel`
- [x] Duplicate panel or entitlement returns 409, not 500 — e2e `returns 409 instead of 500`
- [x] Route registration is audited and validated; probes are platform-admin only — e2e `audits route registration`
- [x] Logout and rotation require an allowed Origin; logout clears cookies with the same attributes (Secure for `__Host-`) — e2e `requires an allowed Origin`
- [x] Login CSRF, workload password login and TOTP replay are rejected — e2e `rejects login CSRF`
- [x] Panel tokens are Ed25519, published via JWKS, and die with their session — e2e `signs panel tokens`, `src/common/crypto.spec.ts`
- [x] Audit log is append-only in the database — e2e `keeps the audit log append-only`
- [x] Parallel outbox dispatchers do not concurrently claim the same row — e2e `never dispatches the same outbox row twice`
- [x] The publisher retains unacknowledged rows on broker errors and retries after recovery — e2e `keeps unacknowledged events pending`
- [x] Migrations run only with the migration role; CI tests as the least-privilege runtime role — `.github/workflows/ci.yml`
- [x] NestJS 11 (Express 5); `npm audit` reports no advisories and CI fails on any high or critical finding — `.github/workflows/ci.yml`

## Open items (not done in this change)

- Tenant / agency scoping of principals, panels and audit (rules §7). Needs an agreed tenant model.
- SSO (OIDC) with phishing-resistant MFA for staff instead of local password + TOTP (diagram 49).
- Provision a durable HTTP broker ingress, dead-letter handling and outbox lag alerts. Configure `OUTBOX_PUBLISH_URL` and `OUTBOX_PUBLISH_TOKEN` before production startup. The ingress MUST acknowledge only after durable broker acceptance, and deduplicate on `eventId`; otherwise a 2xx response can lose an event. Retries are at-least-once.
- Workflow engine: persisted steps, compensations and timers beyond the status state machine.
- Anonymous consent for visitors before login (rules §9); consent currently requires a session.
- SAST, SBOM, signed image and artifact attestation in CI (rules §6).
- Management panel UI (bilingual, four theme/locale combinations); API error messages are Persian only and clients should localise by `error.code`.
