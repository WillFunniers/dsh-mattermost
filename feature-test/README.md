# Feature acceptance suite — Approval Bridge, Session Navigator, Multi-Bot

`run.sh` asserts the behaviour introduced by the approval/navigator/multi-bot work.
It is **separate from `scheduler-test/`** on purpose: that suite covers durable jobs and must
keep doing so unchanged, while these assertions drive a real Mattermost channel, real reactions
and the native approval seam.

```
run-all.sh          phase driver: restarts ONE isolated instance per configuration
  run.sh core       approvals + navigator (policy=ask, one bot)
  run.sh expiry     approval expiry (approval timeout 30s)
  run.sh never      native `never` policy (DSH_PERMISSION_MODE=danger-full-access)
  run.sh multibot   two configured bots, isolated state/namespaces
```

## Safety guard

The suite posts real messages, adds real reactions and asks the native approval seam for real
decisions. `run.sh` therefore refuses to start unless:

- `MMT_HOME` matches `$HOME/.dsh-mmt-*` (never the production `$HOME/.dsh`), and
- the probe at `PROBE` reports `started: true` **and** `connected: true`, and
- at least one bot is configured and connected.

Exit codes: `0` all groups passed, `1` at least one assertion failed, `2` bad invocation or an
unsafe target, `3` the instance was not serving the plugin (nothing was asserted).

## Environment

| Variable | Meaning |
| --- | --- |
| `MMT_HOME` | Isolated DSH home. Must be `~/.dsh-mmt-*`. |
| `MMT_RESTART` | Script that restarts that instance and reloads its environment (used by `run-all.sh`). |
| `PROBE` | Probe base URL of the isolated instance. |
| `MM_CHANNEL` | Test channel id. |
| `MM_USER` | Authorized human user id carried by synthetic inbound events. |
| `MM_BOT` | The bot's own user id (self-reaction check). Optional. |
| `MM_OTHER_USER` | An unrelated id, authorized for the second bot only. Optional. |
| `TOKEN_FILE` | Mattermost bot token file. Defaults to `$HOME/.dsh/mattermost-token`. |

## Why some checks look indirect

Three limitations of a single-identity test environment shape the suite, and each is called out in
the assertion text rather than hidden:

1. **Reactions cannot be sent as another human** — the token belongs to the bot, and Mattermost
   refuses to save a reaction "on behalf of another user". The suite therefore drives the reaction
   *handler* directly with the authorized user id (the same entry point a real frame reaches), and
   separately proves that a real `reaction_added` frame arrives over the WebSocket **and is ignored
   when the reactor is the bot itself**.
2. **`approval/request` is a waterfall, not an event** — a request is claimed by whichever listener
   answers first. The happy path therefore calls the same `ctx.waterfall(...)` dispatch the approval
   service performs (`/mm/waterfall`). The service's own turn guard is verified separately by
   asserting that an out-of-turn `approval.request()` is refused (`A11`), and the `never` policy is
   verified through the real service inside a real turn (`A12`).
3. **A synthetic turn must never be written into a session** — appending `turn/start` from outside
   the agent loop makes the stored log fail validation on the next load. The suite does not do it;
   an earlier revision did, and the corruption it caused is why `A11` exists in this form.

## Groups

| Group | What it locks down |
| --- | --- |
| `A1` | A native request reaches Mattermost as a card, with a complete pending record. |
| `A2` | A reaction approves exactly once; the card is rewritten with the outcome. |
| `A3` | A rejection never grants. |
| `A4` | A later reaction cannot change a settled request. |
| `A5` | `/approve` on a settled request reports `settled` instead of re-deciding. |
| `A6` | An unauthorized user's reaction neither grants nor settles. |
| `A7` | A decision from another channel (`wrong-channel`) or another bot (`forbidden`) is refused. |
| `A8` | An unanswered request expires to `unavailable` and cannot be revived. |
| `A10` | An agent this plugin does not own is delegated, and no card is posted for it. |
| `A11` | An out-of-turn `approval.request()` is refused by the native service. |
| `A12` | Under a `never` policy the service rejects before the bridge is consulted. |
| `A13` | Credentials are masked, oversize arguments are marked truncated, and the card carries an arguments section recovered from a real `callId`. |
| `S1`–`S5`, `S7`, `S9` | Current session, generation list, `/new`, `/switch`, thread isolation, unknown selectors, and that no foreign session is ever shown. |
| `M1`, `M2`, `M5` | Two bots: independent WebSockets and state files, distinct sessions for the same channel and thread, and per-bot reconnect isolation. |
| `M6` | Legacy mapping: the session id survives, the bare key is kept, the scoped key is written, and no other bot can see it. |

## Clean install (no Mattermost, isolated DSH_HOME)

`clean-install-smoke.sh` creates a temporary `DSH_HOME`, installs the checkout
with the documented dependency step, boots DSH without any Mattermost settings,
and asserts the plugin row activates with Web Approval off. Both supported
install paths are exercised: `dsh plugin add` and the manual symlink + bundles.

```
bash feature-test/clean-install-smoke.sh
KEEP=1 bash feature-test/clean-install-smoke.sh   # keep the temp home on failure
```

It needs `dsh`, `pnpm`, `node`, and registry access for `@deepseek-ai/schemastery`.
It never reads the production home, profile, credentials, or Mattermost config.

## Offline suites (no Mattermost at all)

These run under `node --test` with a stub transport, so they need no server, no token and no
network:

```
node --unhandled-rejections=strict --test \
  feature-test/command-entry.test.mjs \
  feature-test/web-route.test.mjs \
  feature-test/web-wiring.test.mjs \
  feature-test/approval-web.test.mjs \
  feature-test/a3-race.test.mjs
```

| File | Covers |
| --- | --- |
| `command-entry.test.mjs` | D1 command admission (bare/mentioned/gated/unknown) |
| `web-route.test.mjs` | A1.1 routing: priority, mode table, DM-only verification, TTL, isolation |
| `web-wiring.test.mjs` | `apply()` wiring: config defaults, approver validation, fail-closed probe |
| `approval-web.test.mjs` | A2: Web card, non-decidable notice, delivery failure, authorization |
| `a3-race.test.mjs` | A3 arbitration: first-wins, loser cleanup, audit fields, abort/dispose/timeout |

## Isolated end-to-end (fake Mattermost)

```
DSH_HOME_TEST=~/.dsh-mmt-dev bash feature-test/web-approval-e2e.sh
```

Refuses any home that is not `…/.dsh-mmt-*`; starts the fake server on 3099, the instance on
3092/3093, and covers: verified DM card decided by Mattermost, DM peer mismatch (nothing sent),
group channel (notice only), and the timeout path (`expired` in the audit).
