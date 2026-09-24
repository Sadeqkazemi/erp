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
- [x] Outbox dispatch is idempotent by event id — `test/platform-core.e2e-spec.ts` deduplicates the outbox
