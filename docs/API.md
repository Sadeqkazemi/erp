# Platform core API

Base path `/v1`. Envelope: `{ success, data }` or `{ success: false, error: { code, message } }`. User-facing messages are Persian. Times are UTC.

The core is a control plane. These routes do not create bookings, tickets, inventory, or ledger rows.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | Database ping |
| GET | `/.well-known/jwks.json` | public | Ed25519 public key that verifies panel tokens |
| POST | `/v1/sessions` | public, throttled (10/min), Origin checked when sent | Staff login requires password and a single-use TOTP. `WORKLOAD` cannot log in with a password. Sets host-only session cookie |
| GET | `/v1/sessions/me` | active session | Current principal ID, username, realm, role and tenant ID for the management UI; no secrets |
| POST | `/v1/sessions/logout` | session + CSRF + Origin | Revoke session |
| POST | `/v1/sessions/rotate` | session + CSRF + Origin | Rotate session and CSRF token |
| GET | `/v1/panels` | session | Panels the caller is entitled to. Empty list when none |
| POST | `/v1/panels` | platform admin + CSRF + Origin + idempotency key | Register a panel. Duplicate code → `409 CONFLICT` |
| POST | `/v1/entitlements` | platform admin + CSRF + Origin | Grant a staff panel. Self-grant and customer/agency targets are rejected. Duplicate → `409 CONFLICT` |
| DELETE | `/v1/entitlements/:id` | platform admin + CSRF + Origin | Revoke an entitlement; existing panel tokens stop passing gateway decisions |
| POST | `/v1/panels/:code/access-tokens` | entitled staff + CSRF + Origin | Short-lived EdDSA token (`iss`, `sub`, `aud`, `realm`, `panelId`, `sid`, `jti`, `iat`, `exp`). It stops working when its session is revoked or panel access is removed |
| POST | `/v1/gateway/routes` | platform admin + CSRF + Origin | Register a versioned route contract (`/vN/...`, `http(s)` upstream without credentials). Audited |
| POST | `/v1/gateway/decisions` | panel bearer token | Body `{ method, pathPattern, version }`. Requires a live session, active staff principal, active panel and current entitlement; audience and realm must match. Domain services still enforce object permissions |
| POST | `/v1/gateway/routes/:id/probe` | platform admin + CSRF + Origin | Upstream timeout stays inside the gateway call. Core health stays up. Redirects are not followed |
| POST | `/v1/workflow-runs` | staff + CSRF + Origin + idempotency key | Start workflow engine state only |
| POST | `/v1/workflow-runs/:id/transitions` | run starter or platform admin + CSRF + Origin | Legal engine transitions only, serialised per run |
| POST | `/v1/workflow-runs/:id/steps` | run starter or platform admin + CSRF + Origin + idempotency key | Create a unique step with `{stepKey,timeoutSeconds}` and persisted UTC deadline; run must be active |
| POST | `/v1/workflow-runs/:id/steps/:stepKey/transitions` | run starter or platform admin + CSRF + Origin | Record step status (`PENDING→RUNNING→SUCCEEDED`, or failure/compensation). Execution remains in the owning service |
| POST | `/v1/consents` | session + CSRF + Origin | Record analytics or advertising grant/withdrawal |
| GET | `/v1/consents/me` | session | Optional cookies default to denied |
| POST | `/v1/visitor-consents` | Origin, rate limit; anonymous | Record optional cookie grant or withdrawal, set opaque HttpOnly visitor cookie |
| GET | `/v1/visitor-consents/me` | anonymous visitor cookie | Latest optional cookie decisions; both denied when absent |
| GET | `/v1/audit-events` | platform admin | Append-only control-plane audit (enforced by a database trigger), with optional `limit` (1–100), `cursor`, `action`, `correlationId`, `from`, `to` query parameters. Existing `data` array includes `createdAt` and `actorPrincipalId`; `page.nextCursor` is null at the end |
| POST | `/v1/workflow-definitions` | platform admin + CSRF + Origin | Register one immutable versioned `definitionKey`, owner service and 1–32 unique step keys with 1–604800-second deadlines. A changed contract needs a new key/version; 409 on duplicate |
| GET | `/v1/control-plane/services` | platform admin | Cursor-paged active panel owners with panel/route counts and the latest manual route probes. `health` is `UNKNOWN`, `UP`, `DOWN`, `DEGRADED` or `STALE`; `observationSource=MANUAL_PROBE` and UTC `lastObservedAt` make freshness explicit. Five minutes without a complete fresh route set becomes `STALE`. `limit` 1–100; `page.nextCursor` is null on the last page |
| POST | `/v1/gateway/routes/:id/probe` | platform admin + CSRF + Origin | Bounded GET probe using the registered route timeout. Appends `UP`/`DOWN`, HTTP status, latency and stable failure category to control-plane observation storage; HTTP errors are not healthy. Does not read or store the response body |
| GET | `/v1/control-plane/summary` | platform admin | Actual counts of panels, route contracts, workflow statuses, pending/retried outbox events, oldest pending age and seven UTC days of audit counts. `domainSales.status=UNCONFIGURED` until the owning service is integrated |
| GET | `/v1/outbox/dead-letters` | platform admin | Last 100 halted outbox events and failure details, with no event payload |
| POST | `/v1/outbox/dead-letters/:id/requeue` | platform admin + CSRF + Origin | Audited replay after investigating a failed event; preserves its event ID |

Agency login at `POST /v1/sessions` requires `tenantId` (UUID). The username is looked up within that tenant; staff and customer sessions must omit `tenantId`.

Workflow step deadlines are checked periodically. Expired pending/running steps become failed; runs with successful sibling steps enter `COMPENSATING`, otherwise `FAILED`. A compensated run requires each step to be either compensated or failed. Core stores orchestration state only. Domain services own business state, side effects and compensation evidence.

Idempotency keys: header `Idempotency-Key`, 8–128 characters of `[A-Za-z0-9_-]`, scoped to the caller and the operation. The same key with a different body returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.

`X-Request-Id` is echoed when it matches `[A-Za-z0-9._:-]{8,128}`; otherwise the server generates one.

Session cookie in production: `__Host-bj_session`; `Secure`; `HttpOnly`; `Path=/`; `SameSite=Lax`; no `Domain`. CSRF header: `X-CSRF-Token`. State-changing cookie calls also require an allowed `Origin`.
