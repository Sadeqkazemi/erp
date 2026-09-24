# BlueJet Platform Core

The control plane is now a Cloudflare Worker serving the bilingual panel and a read-only, versioned API. Persian uses RTL and a right sidebar; English uses LTR and a left sidebar. Both have light and dark themes.

## First implemented slice

- `GET /api/v1/control-plane/health`: Worker health and UTC time.
- `GET /api/v1/control-plane/services`: target service catalog with explicit `unconfigured` connection and `unknown` health.
- `GET /api/v1/control-plane/summary`: target, connected and unknown counts.
- The monitoring page reads its service catalog from the API. If it fails, the page displays an unavailable state.

Run `npm test` to build the Worker bundle and run API tests. The build embeds `dist/index.html` into `dist/server/index.js`, which Sites deploys using `.openai/hosting.json`.

The dashboard business metrics and audit entries remain illustrative, with labels indicating sample data. This release has no application authentication, persistent registry, operational telemetry integrations or business-service data API. Do not treat service registration as a live health check. The API contract and next integration boundaries are in `docs/control-plane-api.md`.
