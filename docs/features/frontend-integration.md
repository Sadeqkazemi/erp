# Platform core UI integration (v1)

The management UI must call the platform core through a same-origin, allowlisted reverse proxy; the proxy is configured with the fixed `BACKEND_ORIGIN` (HTTPS in hosted environments). The core's `ALLOWED_ORIGINS` must include the actual UI origin. Do not copy session or panel tokens into local storage. The core owns `v1` APIs and the session cookie; the UI owns language and theme preferences.

| Flow | Core endpoint | Authorization | UI behavior |
| --- | --- | --- | --- |
| Sign in | `POST /v1/sessions` | Staff username/password/TOTP; `Origin` checked | Keep returned CSRF token in memory; session ID only in HttpOnly cookie |
| Restore session | `GET /v1/sessions/me` | Active cookie | Require `PLATFORM_ADMIN` for management screens; returns ID, username, realm, role and tenant ID |
| Dashboard | `GET /v1/control-plane/summary` | Platform admin | Show stored control-plane counts; `domainSales.status=UNCONFIGURED` means no sales number |
| Audit | `GET /v1/audit-events?limit=30&cursor=…` | Platform admin | Show timestamp, actor principal ID, action, object and correlation ID; cursor pages |
| Logout | `POST /v1/sessions/logout` | Active cookie, allowed Origin and `x-csrf-token` | Clear local state and show sign-in screen |

Responses are `Cache-Control: no-store`. UI must distinguish 401, 403 and 503, never substitute fabricated values on failure. The backend stays the policy enforcement point; a UI role check is only a presentation gate. The Worker preview is a separate Sites project and requires a deployed core, a valid `BACKEND_ORIGIN`, approved origin, database migration and an enrolled staff administrator before its connected experience can run. Do not publish the connected Worker over the existing preview until these runtime dependencies exist. Real sales reporting, telemetry, SSO and domain authorization remain separate delivery work.
