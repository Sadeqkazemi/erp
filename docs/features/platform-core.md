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
- [x] Gateway decisions recheck active staff, panel and entitlement; admin can revoke an entitlement with an audit/outbox event, immediately denying previously issued tokens — `gateway-revocation.spec.ts`
- [x] Audit log is append-only in the database — e2e `keeps the audit log append-only`
- [x] Audit read supports bounded page size, stable UTC timestamp/ID cursor, action/correlation/time filters and admin-only access — `audit-query.e2e-spec.ts`
- [x] Parallel outbox dispatchers do not concurrently claim the same row — e2e `never dispatches the same outbox row twice`
- [x] The publisher retains unacknowledged rows on broker errors and retries after recovery — e2e `keeps unacknowledged events pending`
- [x] Bounded retry and durable dead-letter state after eight failures, admin-only inspection and audited replay with the same event ID — `outbox-recovery.e2e-spec.ts`
- [x] Admin-only control-plane summary reports real panel/workflow/audit/outbox counts; domain sales is explicitly unconfigured until its owning API exists.
- [x] Admin-only paged service catalog derives actual active panel owners and registered route counts from the core registry, without claiming live service health. HTTP 5xx probes are reported as unsuccessful (`service-catalog.spec.ts`).
- [x] Versioned workflow definition registry stores owner, allowed steps and their deadlines. Production refuses unregistered runs, wrong owners and unapproved steps/timeouts; existing nonproduction tests can still create legacy ad hoc runs. Registration is immutable and audited (`workflow-definitions.spec.ts`). Domain callbacks and compensation remain separate work.
- [x] Migrations run only with the migration role; CI tests as the least-privilege runtime role — `.github/workflows/ci.yml`
- [x] NestJS 11 (Express 5); `npm audit` reports no advisories and CI fails on any high or critical finding — `.github/workflows/ci.yml`
- [x] Isolated CI build produces a downloadable build archive, SHA-256 digest and CycloneDX SBOM from the lockfile; signing, provenance attestation and UAT promotion still require release infrastructure — `.github/workflows/build-evidence.yml`.

## Open items (not done in this change)

- [x] Agency identity lookup uses explicit tenant UUID; audit records carry tenant ID, and unmapped legacy agency identities cannot log in (`agency-scope.spec.ts`). Still required: authoritative agency registry/backfill, tenant-scoped panel entitlements, gateway/domain object policy and cross-agency end-to-end denial tests.
- SSO (OIDC) with phishing-resistant MFA for staff instead of local password + TOTP (diagram 49).
- Provision a durable HTTP broker ingress and external outbox lag/dead-letter alerts. Configure `OUTBOX_PUBLISH_URL` and `OUTBOX_PUBLISH_TOKEN` before production startup. The ingress MUST acknowledge only after durable broker acceptance, and deduplicate on `eventId`; otherwise a 2xx response can lose an event. Retries are at-least-once.
- [x] Workflow step status and deadlines persist; due-step scanner marks failures, moves runs into failure/compensation, and blocks premature completion (`workflow-steps.e2e-spec.ts`). Versioned definitions now gate production runs and steps. Remaining: authenticated domain callbacks, actual compensation commands/evidence, retries, and end-to-end domain reconciliation.
- [x] Anonymous visitor consent API before login; origin-checked POST, HttpOnly opaque cookie, stored hash, default denial and withdrawal (`visitor-consent.spec.ts`). Website integration must gate optional scripts, surface policy versions, and define retention before rollout.
- SAST, signed image and artifact provenance attestation in CI, plus controlled UAT/Production promotion (rules §6).
- Management panel UI (bilingual, four theme/locale combinations); API error messages are Persian only and clients should localise by `error.code`.
