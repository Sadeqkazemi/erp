# Control plane API · first vertical slice

Owner: BlueJet platform core. This read-only release owns only the target service catalog and its connection configuration; it owns no PNR, crew, aircraft, payments, finance or maintenance records.

| Endpoint | Scope | Result |
| --- | --- | --- |
| `GET /api/v1/control-plane/health` | platform health | Worker availability, UTC timestamp |
| `GET /api/v1/control-plane/services` | service catalog | Target names, domains, descriptions and explicit unknown/unconfigured status |
| `GET /api/v1/control-plane/summary` | catalog summary | Target and connected count, unknown health count |

All endpoints return JSON with `Cache-Control: no-store`. Unknown routes return `NOT_FOUND`; writes return `METHOD_NOT_ALLOWED`. This private preview has no app-owned identity or role authorization. Do not expose it publicly as an operations console. No operational service health probe, SSO, durable registry, workflow or audit ingestion has been implemented. Connecting a service requires an authenticated integration, approved per-service endpoint and owner, credential storage, timeout, timestamp and failure policy. The dashboard sales and audit values remain visibly illustrative.
