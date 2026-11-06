# Changelog

All notable changes to this project are documented here.

## [0.2.0] - 2026-11-05

### Added

- **Approval Bridge**: native DSH one-shot approval requests are posted as a
  Mattermost card and settled by a reaction or a reply command through the
  `approval/request` waterfall. Fail-closed: no card, no decision, no grant.
  The card expires after a configurable timeout and every settled request is
  written to a local audit log.
- **Web-origin approval notifications**: a DSH Web approval can optionally be
  announced in Mattermost, restricted to a verified one-to-one DM. Off by
  default (`webApproval.approvers` empty).
- **Session Navigator**: `/sessions`, `/session` and `/switch` list and re-point
  the current conversation's own sessions without touching other threads, users
  or bots.
- **Multiple bots**: one plugin instance can drive several Mattermost bot
  accounts with independent tokens, sockets, state files, authorization sets and
  session namespaces. Existing single-bot deployments keep their sessions through
  a one-way legacy-key migration.
- **Deployment checks**: `deploy/preflight.sh`, `deploy/verify.sh` and an
  isolated mock-Mattermost test suite.
- **Acceptance tests** under `feature-test/` (stub-based suites plus an isolated
  live-instance driver).

### Security

- Terminal approval cards keep a masked argument snapshot for re-rendering; the
  snapshot is never persisted or audited (O1).
- Card delivery logs distinguish success from failure at the correct point (O2).
- Delivery-failure messages are folded to one line, stripped of control
  characters and masked before logging (`oneLineError`, C.1).

### Fixed

- Clean installs now declare the runtime dependency model: `@deepseek-ai/schemastery`
  is installed by the plugin, while the six `@deepseek-ai/dsh-*` runtime packages
  are declared as host-provided peers. `pnpm-workspace.yaml` disables pnpm's
  automatic peer installation so the checkout does not create a second copy of
  the DSH runtime.
- Added `feature-test/clean-install-smoke.sh`, which creates a temporary
  `DSH_HOME`, installs the checkout, boots DSH, and asserts the plugin activates
  with Web Approval off.

### Changed

- Package version bumped to `0.2.0`.
- `web-wiring` tests derive fixture timestamps from the current time instead of
  a fixed date, so the 24-hour TTL assertion cannot expire as wall-clock time
  advances.

### Limitations

- The live Mattermost end-to-end suite (`feature-test/run.sh`) and the scheduler
  suite require an isolated Mattermost instance and harness; they are not part
  of the default automated run.
- The clean-install smoke test covers the default Web profile without a
  Mattermost server; real E2E still requires an isolated Mattermost instance.

## [0.1.0] - 2026-10-19

- Initial public production release: Mattermost WebSocket inbound, in-process
  DSH agent, shared GUI session, per-thread sessions, queueing/steering,
  reconnect recovery, idle eviction, default-deny authorization, bot-loop
  protection, delayed jobs and fault observability.
