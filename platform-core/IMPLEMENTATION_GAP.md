# Architecture gap and delivery sequence

Source: the supplied 51-view architecture and BLUEJET_PLATFORM_RULES v1.1. Status checked 24 September 2026.

| Control-plane capability | Current source state | Next acceptance gate |
| --- | --- | --- |
| Panel registry | PostgreSQL-backed service with OIDC validation and append-only registration audit in `service/`; not deployed | Migration rehearsal, real OIDC and gateway integration, role and tenant tests in isolated UAT |
| Identity and permission policy | Registry validates signed token claims; no dedicated Identity/Policy service | Approve issuer, roles, scopes, separation of duties and MFA; test deny-by-default paths |
| API gateway | Target architecture only | Versioned route policy, service identity, timeout, rate limit and correlation IDs |
| Workflow engine | Target architecture only | Separate durable state, compensation, idempotent commands and failure recovery |
| Audit service | Registration audit row in registry transaction only; not a centralized tamper-resistant audit service | Independent append-only ingestion, retention, access controls and export audit |
| Observability | Worker preview reports unconfigured/unknown; no service metrics | Real probes, timestamp, alert owner, logs, traces and SLO evidence |
| Business domains | No domain database or write migration in this repository | Inventory existing `blujet2` writers; approve owner and controlled extraction |

The hosted Site under `platform-core/` is a private visual preview with a read-only Worker catalog. It is not the authoritative registry service. Its sample sales and audit graphs must not be used for operational decisions. The registry API in `service/` is designed as an independently deployable PostgreSQL service and must be integrated via a reviewed gateway and identity contract before the panel reads it.

Release path: protected PR → isolated CI → immutable image → isolated UAT with synthetic data and restore exercise → independent Production approval. No production readiness claim follows from passing unit tests alone.
