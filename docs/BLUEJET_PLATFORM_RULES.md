# BlueJet Platform Implementation Rules

Version: 1.1 — based on the 51-diagram target architecture and the current `blujet2` repository. This document supplements the repository's `CLAUDE.md` and `AGENTS.md`. Where implementation and target architecture differ, record the difference and migrate deliberately. Direct user decisions take precedence. In particular, the later bilingual panel decision supersedes the older Persian-only management-panel rule in `CLAUDE.md`; update that repo rule before treating it as authoritative for new panel work.

## 1. Architecture and ownership

1. Treat the Platform Core as a control plane for SSO, permission policy, panel catalog, API gateway, workflow, audit and observability. Do not store bookings, crew records, maintenance tasks or financial ledgers in the Core.
2. Make each new business capability an independently deployable service only when it has a clear data owner and lifecycle. A new UI panel over existing records uses the owning service's API; it does not automatically get a new backend or database.
3. Group channels as Management, Operations and Employees. Site Admin belongs to Employees. Customer website, mobile app and agency portal are channels that call domain APIs.
4. Build every internal management, operations and employee panel in Persian and English with complete translations. Persian uses RTL with the sidebar on the right; English uses LTR with the sidebar on the left. Provide light and dark themes in both languages, with consistent tokens, contrast and a persistent user theme preference. Locale switching must preserve the current page and user-entered state where safe. Persian dates display Jalali and English dates Gregorian; store/transmit UTC and numeric values in a locale-neutral form. Test all four language/theme combinations, navigation, popups, charts and responsive widths.
5. Assign one authoritative writer to each record. PSS is the intended owner of sellable inventory, holds, PNR, tickets and coupons after controlled cutover. The existing booking engine remains authoritative until that cutover is verified.
6. Use versioned HTTP APIs for current facts and committed versioned outbox events for state changes that other services need. Forbid cross-service SQL, shared production schemas and direct writes to another service's database.

## 2. Database decision

**Default:** PostgreSQL with one logical database, application account, migration account, credentials, backup and recovery plan **per service**. Keep Development, CI, UAT and Production in separate environments and networks with separate credentials and keys. Isolate critical PSS and payment storage further when approved availability and capacity targets require it. Redis is a cache and coordination aid, never the authority for a seat, PNR, payment or ticket.

| Service boundary | Authoritative data | Database action |
| --- | --- | --- |
| PSS | Inventory, holds, PNR, ticket, coupon, EMD | Continue separate PSS database; promote writer ownership only after shadow reconciliation and cutover approval. |
| Commerce | Offers, orders and sales channel workflow | Extract from shared backend into its own database without duplicating PSS inventory. |
| Payment and Finance | PSP references, payment reconciliation; financial ledger and settlement respectively | Separate ownership and stores; reconcile every external callback and accounting entry. |
| Flight Ops, Crew | Operational flight state; qualification, duty and roster | Separate service databases and versioned APIs. |
| CAMO, Part 145, Line, Engine Shop | Airworthiness; execution; station work; engine overhaul | Distinct owners and stores with audit, approval and part/aircraft trace. |
| Procurement/Supply, Logistics, HR, Support, Site Content | Purchase/stock; shipment; personnel; cases; website content | Separate stores when extracted; share references by ID and API, not database joins. |
| Identity, Workflow, Audit | Platform control state | Own isolated stores and retention rules; no ownership of domain transactions. |

Database rules:

- Grant each runtime account only needed permissions to its own database. Use separate short-lived migration credentials. No runtime superuser and no common credential across services or environments.
- Keep internal foreign keys and uniqueness constraints inside the owning database. References to another service use opaque identifiers, API validation and reconciliation; never cross-database foreign keys.
- Use UTC timestamps with explicit time zones at presentation edges; fixed-precision monetary values with currency, constrained statuses, version columns and indexes justified by queries. Protect and classify passenger, crew, payment and maintenance data.
- Maintain a transactional outbox and idempotent consumers. Monitor delivery lag, retries, dead letters and reconciliation. Build reporting projections from approved APIs/events and label freshness; projections cannot authorize a sale or aircraft release.
- Use encrypted backup, point-in-time recovery for critical stores, offsite/immutable copy and regular measured restore. Set RPO/RTO per service before production release.

## 3. Migration from the existing backend

1. Inventory current tables, endpoints, jobs and writers; approve the entity owner and compatibility contract.
2. Build the target service and separate database with additive migrations; backfill from a consistent checkpoint and catch up via outbox or change capture.
3. Shadow reads; reconcile counts, checksums and business totals. For PSS, require zero unexplained inventory, PNR, ticket or payment divergence.
4. Shift a small cohort behind a guarded flag. Allow only one authoritative writer per entity throughout the move. Test concurrent last-seat purchases and duplicate payment callbacks.
5. Halt rollout on discrepancy. Roll back routing without overwriting later committed business records. Reconcile and repair with audited business operations.
6. Remove old writes, broad credentials and obsolete routes only after restore proof, acceptance and monitoring.

## 4. API and event contract

Before code, document: owner; consumers; data classification; method/path or event name; version; schema; units/currency/time zone; user/workload identity; tenant and object authorization; approval; stable errors; timeout; retry; idempotency key; rate limit; correlation/audit fields; compatibility and deprecation period; SLO and on-call owner. Generate typed clients from the approved OpenAPI contract. Validate inputs server-side. Every changed contract needs provider and consumer tests.

For cross-service workflows, persist state and compensation. Avoid distributed write transactions and unbounded retries. Publish events only after the owning transaction commits. Deduplicate by event ID and support replay.

## 5. Feature completion

- Complete a vertical slice: schema, domain logic, API, typed client, UI, authorization, logs/traces and tests. Never claim a placeholder or static screen to be an operational panel.
- Management panels use real API-backed values or honest empty states. Follow the latest user-approved bilingual panel rule above even where older repository text says Persian-only. Verify fa/light, fa/dark, en/light and en/dark, including sidebar position, localization, typography, contrast, loading, errors and responsive behavior.
- Run focused concurrency, idempotency, cross-role and cross-agency negative tests for sensitive flows. Verify critical journeys end-to-end in UAT.
- Keep AI recommendations advisory for safety, maintenance, finance and crew assignment. Record provenance, explanation, version and accountable human approval.
- Update contract/schema docs, runbook and roadmap after a verified slice. Document what was tested and what remains unproven.

## 6. CI/CD and environment isolation

- Git holds reviewed source; CI uses disposable runners and test-only data. UAT and Production have separate accounts, networks, hosts/clusters, databases, keys, secret stores and approval rules.
- Build once in CI. Record artifact digest, SBOM and provenance; promote that same verified artifact to UAT and then Production. No production server-side source checkout or rebuild.
- Gate pull requests on reviews, lint, typecheck, meaningful unit and contract tests, security scans and migration checks. Gate UAT on critical E2E journeys, safe dynamic tests, masked data, failure drills and restore proof.
- Gate Production on an independent approver, signed digest, reconciled data, service-specific SLO/load results, controlled migration, canary health and rollback plan. The deployment initiator must not self-approve where platform controls support it.
- Never enable sandbox auth, test payment switches, demo seeds or shared UAT credentials in Production. A failed critical gate stops release; exceptions require a named owner, expiration and compensating control.

## 7. Security and operations

- Require server-side role, object and tenant authorization. Use SSO and strong MFA for privileged access, short-lived workload identity, private service/DB networks, TLS, controlled egress and minimum privileges.
- Do not place secrets, sensitive data or tokens in Git, images, browser bundles or logs. Encrypt sensitive data and rotate keys. Apply patch/vulnerability response based on exposed risk and known exploitation.
- Centralize structured logs, metrics, traces and tamper-resistant audit. Alert on failed admin access, unusual data export, privilege changes, payment/PNR anomalies and message backlogs; name an on-call owner.
- Maintain incident response and tested backup restoration. Do not state that BlueJet was hacked without an incident report and evidence.

## 8. Production no-go conditions

Block deployment if a critical journey fails; inventory, PNR, ticket or financial totals disagree without explanation; unauthorized cross-role/agency access succeeds; UAT reaches Production data; sandbox settings are enabled in Production; DB or internal API ports are public; an unapproved severe finding remains; backup restoration has not been demonstrated; or the artifact differs from the approved UAT build.

**Quality goal:** minimize escaped defects through ownership, contracts, review, meaningful tests, staged rollout and observable recovery. No process can guarantee zero bugs.


## 9. Sales website cookies and consent

- Use a first-party host-only `__Host-` session cookie for customer authentication: `Secure; HttpOnly; Path=/; SameSite=Lax`, without `Domain`; use `Strict` where flows permit. Serve production site and API over HTTPS, rotate sessions after login and privilege changes, set bounded expiration and server-side revocation. Assess cross-site payment redirects explicitly before choosing an exception to SameSite.
- Protect every state-changing cookie-authenticated endpoint with CSRF controls, including origin validation and CSRF token where appropriate. Enforce API-side authorization and object ownership.
- Necessary cookies may run before consent. Block optional analytics and advertising scripts and cookies until explicit purpose-based opt-in. Provide persistent preference controls and withdrawal; record purpose, policy version and timestamp. Review applicable notice and retention rules with legal counsel.
- Cookies contain opaque session IDs or minimal signed preferences only. Fare, holds, orders, PNR, payment and tickets stay in their owning service databases. Never store card data, sensitive personal data or access tokens in cookies or browser storage. Existing language and theme browser preferences need no migration.
- Acceptance gates: inspect real `Set-Cookie` flags under HTTPS; test login, logout, rotation, expiry, CSRF and payment return; verify optional scripts remain blocked before consent and stop after withdrawal; test all language/theme combinations.
