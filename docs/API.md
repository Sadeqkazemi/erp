# Platform core API

Base path `/v1`. Envelope: `{ success, data }` or `{ success: false, error: { code, message } }`. User-facing messages are Persian. Times are UTC.

The core is a control plane. These routes do not create bookings, tickets, inventory, or ledger rows.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | Database ping |
| POST | `/v1/sessions` | public, throttled | Staff login requires password and TOTP. Sets host-only session cookie |
| POST | `/v1/sessions/logout` | session + CSRF + Origin | Revoke session |
| POST | `/v1/sessions/rotate` | session + CSRF + Origin | Rotate session and CSRF token |
| GET | `/v1/panels` | session | Panels the caller is entitled to. Empty list when none |
| POST | `/v1/panels` | platform admin + CSRF + idempotency key | Register a panel |
| POST | `/v1/entitlements` | platform admin + CSRF | Grant a staff panel. Self-grant and customer/agency targets are rejected |
| POST | `/v1/panels/:code/access-tokens` | entitled staff + CSRF | Short-lived token whose audience is that panel |
| POST | `/v1/gateway/routes` | platform admin + CSRF | Register a versioned route contract |
| POST | `/v1/gateway/decisions` | panel bearer token | Allow only when token audience and realm match the route |
| POST | `/v1/gateway/routes/:id/probe` | session + CSRF | Upstream timeout stays inside the gateway call. Core health stays up |
| POST | `/v1/workflow-runs` | staff + CSRF + idempotency key | Start workflow engine state only |
| POST | `/v1/workflow-runs/:id/transitions` | staff + CSRF | Legal engine transitions only |
| POST | `/v1/consents` | session + CSRF | Record analytics or advertising grant/withdrawal |
| GET | `/v1/consents/me` | session | Optional cookies default to denied |
| GET | `/v1/audit-events` | platform admin | Append-only control-plane audit |

Session cookie in production: `__Host-bj_session`; `Secure`; `HttpOnly`; `Path=/`; `SameSite=Lax`; no `Domain`. CSRF header: `X-CSRF-Token`. State-changing cookie calls also require an allowed `Origin`.
