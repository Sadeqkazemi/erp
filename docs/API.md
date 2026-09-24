# Platform core API

Base path `/v1`. Envelope: `{ success, data }` or `{ success: false, error: { code, message } }`. User-facing messages are Persian. Times are UTC.

The core is a control plane. These routes do not create bookings, tickets, inventory, or ledger rows.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | Database ping |
| GET | `/.well-known/jwks.json` | public | Ed25519 public key that verifies panel tokens |
| POST | `/v1/sessions` | public, throttled (10/min), Origin checked when sent | Staff login requires password and a single-use TOTP. `WORKLOAD` cannot log in with a password. Sets host-only session cookie |
| POST | `/v1/sessions/logout` | session + CSRF + Origin | Revoke session |
| POST | `/v1/sessions/rotate` | session + CSRF + Origin | Rotate session and CSRF token |
| GET | `/v1/panels` | session | Panels the caller is entitled to. Empty list when none |
| POST | `/v1/panels` | platform admin + CSRF + Origin + idempotency key | Register a panel. Duplicate code → `409 CONFLICT` |
| POST | `/v1/entitlements` | platform admin + CSRF + Origin | Grant a staff panel. Self-grant and customer/agency targets are rejected. Duplicate → `409 CONFLICT` |
| POST | `/v1/panels/:code/access-tokens` | entitled staff + CSRF + Origin | Short-lived EdDSA token (`iss`, `sub`, `aud`, `realm`, `sid`, `jti`, `iat`, `exp`). It stops working when its session is revoked |
| POST | `/v1/gateway/routes` | platform admin + CSRF + Origin | Register a versioned route contract (`/vN/...`, `http(s)` upstream without credentials). Audited |
| POST | `/v1/gateway/decisions` | panel bearer token | Body `{ method, pathPattern, version }`. Allow only when the token is valid, its session is live, and audience and realm match that route version |
| POST | `/v1/gateway/routes/:id/probe` | platform admin + CSRF + Origin | Upstream timeout stays inside the gateway call. Core health stays up. Redirects are not followed |
| POST | `/v1/workflow-runs` | staff + CSRF + Origin + idempotency key | Start workflow engine state only |
| POST | `/v1/workflow-runs/:id/transitions` | run starter or platform admin + CSRF + Origin | Legal engine transitions only, serialised per run |
| POST | `/v1/consents` | session + CSRF + Origin | Record analytics or advertising grant/withdrawal |
| GET | `/v1/consents/me` | session | Optional cookies default to denied |
| GET | `/v1/audit-events` | platform admin | Append-only control-plane audit (enforced by a database trigger) |

Idempotency keys: header `Idempotency-Key`, 8–128 characters of `[A-Za-z0-9_-]`, scoped to the caller and the operation. The same key with a different body returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.

`X-Request-Id` is echoed when it matches `[A-Za-z0-9._:-]{8,128}`; otherwise the server generates one.

Session cookie in production: `__Host-bj_session`; `Secure`; `HttpOnly`; `Path=/`; `SameSite=Lax`; no `Domain`. CSRF header: `X-CSRF-Token`. State-changing cookie calls also require an allowed `Origin`.
