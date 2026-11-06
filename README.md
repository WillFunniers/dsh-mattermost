# dsh-mattermost

**English** | [简体中文](./README.zh-CN.md)

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that turns Mattermost into a task entry point for DSH agents.

Instead of running an external bridge process, `dsh-mattermost` loads **inside the DSH Web process** and drives an in-process agent. When the DSH Web process is running, Mattermost and the DSH Web GUI operate on the same live agent/session within that process.

```
Mattermost  ──WebSocket──▶  dsh-mattermost  ──▶  DSH Web process
                                                      │
                                                      ▼
                                                  live Agent
                                                      ↕
                                                 DSH Session
                                                      ↕
                                                 DSH Web GUI
```

---

## Features

- **Mattermost WebSocket inbound** — no polling; the plugin holds its own connection.
- **In-process agent** — the agent is created in the DSH Web process, not spawned as a child process.
- **Shared live session with the GUI** — Mattermost and the DSH Web GUI resolve to the same agent object while that process is running.
- **Per-thread sessions** — each Mattermost thread gets its own isolated conversation.
- **`/task` command** — explicitly start an independent task session.
- **Queueing instead of hidden interruption** — a message sent to a busy session is queued as a follow-up.
- **Explicit steering** — `/steer` is the only way to redirect a task that is already running.
- **No request-scoped lifetime** — a reply is not tied to the inbound WebSocket frame or an open HTTP request.
- **Reconnect recovery** — WebSocket reconnect plus REST backfill and deduplication.
- **Delivery resilience** — transient send failures are retried; an unusable thread root falls back to a channel post.
- **Idle agent eviction** — the runtime agent is released after a period of inactivity while the durable session is kept.
- **Default-deny authorization** — user and channel allowlists.
- **Bot-loop protection** — a per-channel budget limits bot-to-bot exchanges.
- **Approval Bridge** — DSH's native one-shot approval requests are posted as a Mattermost card and settled by a reaction or a reply command, through the native `approval/request` waterfall. Fail-closed: no card, no decision, no grant.
- **Session Navigator** — `/sessions`, `/session` and `/switch` list and re-point the current conversation's own sessions; other threads, users and bots are never touched.
- **Multiple bots** — one plugin instance can drive several Mattermost bot accounts with independent tokens, WebSocket connections, state files, authorization sets and session namespaces.

---

## Architecture

The plugin is a Cordis plugin. It exports `name`, `inject`, `Config`, and `apply(ctx, config)`.

It depends on the DSH services `agents` and `agentDefaultModel`, and reads `credentials`, `agentPresets`, `sessionQuery`, and `permissionPresets` when present.

```
Mattermost Server
      │  WebSocket (Bearer header auth, application-level ping)
      ▼
  mattermost.js ── inbound post ──▶ index.js (admission + commands)
                                        │
                                        ▼
                                   mapping.js   chatKey → sessionId
                                        │
                                        ▼
                                   agents.js    live agent reuse
                                        │        sessionQuery.observeSession
                                        │        resume / create
                                        ▼
                                  DSH Session / Event bus
                                        │
                        ┌───────────────┴────────────────┐
                        ▼                                ▼
                  outbound.js                      DSH Web GUI
              (session/event → REST post)     (same process, same agent)
```

### Why not an external bridge?

|                              | `dsh-mattermost`                      | External bridge                     |
| ---------------------------- | ------------------------------------- | ----------------------------------- |
| Runs where                   | Inside the DSH Web process            | A separate process                  |
| Live agent                   | Shared with the DSH Web GUI           | Independent                         |
| GUI and Mattermost, one session | Yes, while the process is running  | Not inherently                      |
| Long task and request lifetime | Not tied to a Mattermost request    | Depends on the bridge               |
| Session ownership            | Same process                          | Cross-process                       |
| Mattermost WebSocket         | Owned by the plugin                   | Owned by the bridge                 |

Both designs are valid. This one exists because an in-process agent removes cross-process session contention and process-lifetime limits, at the cost of sharing a fault domain with DSH Web.

---

## Session Model

All session ids are derived in one place (`mapping.js`) from a **chat key**:

| Source                          | Chat key                |
| ------------------------------- | ----------------------- |
| Direct message                  | `dm:<channel_id>`       |
| Channel root message            | `ch:<channel_id>`       |
| Reply inside a thread           | `th:<root_post_id>`     |
| `/task` issued in a channel root | `th:<command_post_id>` |

The session id is a deterministic function of the chat key, so the mapping survives restarts without a lookup table. A durable map is also kept on disk to record chat metadata and `/new` generations.

### Channel

Channel root messages share one session, giving a continuous conversation:

```
#channel
└── root messages ──────────────▶ session A
```

### Threads

Each thread is an independent session:

```
#channel
├── root ───────────────────────▶ session A
├── thread 1 ───────────────────▶ session B
└── thread 2 ───────────────────▶ session C
```

Replying in a thread keeps using that thread's session. Different threads never share one.

### `/task`

`/task <prompt>` starts a **new** session. It is intended for long or independent work:

```
/task analyze the current project
```

### `/new`

`/new` bumps the generation for the current chat key, starting a fresh conversation while leaving the previous session on disk.

---

## Concurrency

Different sessions run concurrently. There is no application-level concurrency cap in this plugin; the practical limit is the machine and the model provider.

```
Session A ───── running
Session B ───── running
Session C ───── running
```

Within one session, messages do not interrupt each other:

```
message 1 ──▶ running
message 2 ──▶ followup() ──▶ queued
```

**Messages sent to a busy session are queued as follow-ups.** They are not merged into the running task.

`/steer <text>` is the explicit, opt-in mechanism for changing the direction of a task that is already running. Nothing steers automatically.

`/stop` requests cancellation of the current turn.

---

## Long-running Tasks

The plugin does not use the inbound WebSocket frame or an open HTTP request to keep a task alive. A reply is delivered from the durable session event bus, so the task may run far longer than any request timeout.

The runtime owner is still the DSH Web process:

```
send message ──▶ agent runs ──▶ (may take a long time) ──▶ reply
```

There is no fixed per-task timeout imposed by this plugin.

However, a live agent is **process-local**. Restarting the DSH Web process ends the current in-flight turn. Session state itself is durable — the conversation is persisted and can be resumed — but the agent object does not survive a restart.

> Session state is durable, while a live agent is process-local and may need to be resumed after a restart.

---

## Recovery

During a reconnect the adapter works to reduce both message loss and duplicate delivery:

- **Reconnect** — automatic reconnect with exponential backoff.
- **REST backfill** — after reconnecting, channels are polled for posts newer than the last seen timestamp.
- **Deduplication** — a bounded set of processed post ids prevents the same post from being handled twice (for example, once live and once via backfill).
- **Delivery retry** — transient send failures are retried with backoff.
- **Thread-root fallback** — if a reply cannot be posted into its thread (for example the thread root no longer exists), it is posted to the channel instead of being dropped.

These mechanisms reduce loss and duplication; they are not a formal exactly-once guarantee.

---

## Idle Eviction

A live agent holds runtime resources for as long as it exists. The plugin therefore separates two things:

```
Durable session   ≠   Live agent object
```

After `idleAgentTtlMs` of inactivity, a sweep releases the runtime agent:

```
Live agent ──idle past TTL──▶ dispose runtime
                                   │
Durable session remains ◀──────────┘
                                   │
future message ──▶ sessionQuery.observeSession ──▶ resume
```

An agent is never evicted while it is running, while a creation is in flight, or while it has recent activity. The sweep runs every `idleSweepIntervalMs`.

---

## Security

Authorization is **default-deny**.

- `allowedUsers` — the Mattermost user ids permitted to use the bot.
- `allowAll` — set to `true` to accept everyone (development only).
- `channels` — an optional channel allowlist. Empty means every channel the bot is in.
- `freeResponseChannels` — channels that respond without an `@mention`.

With `allowAll: false` and an empty `allowedUsers`, **nobody** is accepted.

**Unauthorized users are rejected before session/agent/workspace creation.** An unauthorized post does not mint a session, does not create an agent, and does not produce a reply. It is recorded as a warning:

```
unauthorized inbound userId=<id> channelId=<id> reason=unauthorized
```

The bot also never reacts to its own posts.

### Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository if it is enabled; otherwise contact the maintainer through the repository's existing channel. No security email address is published here.

### Bot loop protection

Two bots that auto-reply to each other can loop indefinitely:

```
bot ──▶ plugin ──▶ reply ──▶ other bot ──▶ plugin ──▶ ...
```

The adapter bounds this with a per-channel budget:

- `allowBotMentions` — whether bot-authored posts may trigger at all.
- `botChainMax` — how many consecutive bot-triggered exchanges are allowed per channel.
- `botChainWindowMs` — a quiet period after which the budget resets.

A bot post must address the bot explicitly (an `@mention`, or a DM) to trigger anything; ambient bot chatter is ignored. Any human message in the channel also resets that channel's budget.

### Credentials

Never commit Mattermost credentials to the repository. Provide the token through the DSH credential store, or through an environment variable. See [Configuration](#configuration).

---

## Installation

This is a **source-installed DSH plugin**, not a standalone Node application. It requires:

- **DSH 0.2.1-rc.2** — the host supplies the `@deepseek-ai/dsh-*` runtime packages declared as `peerDependencies`.
- **Node.js 24** and **pnpm** (the validated toolchain).
- One plugin-owned dependency, `@deepseek-ai/schemastery` (`~3.18.5`), installed by the steps below.

The plugin does not install the six DSH runtime peer packages itself. DSH resolves them from its own installation. `pnpm-workspace.yaml` sets `autoInstallPeers: false` so a local install does not create a second, potentially incompatible copy. Do not add those peers to the profile.

1. Clone and install the plugin-owned dependency:

   ```bash
   git clone https://github.com/WillFunniers/dsh-mattermost.git
   cd dsh-mattermost
   pnpm install --prod --ignore-scripts
   ```

   This installs only `@deepseek-ai/schemastery`. Run it before linking the checkout: `dsh plugin add` records a `link:` dependency and does not install a link target's dependencies.

2. Install into a DSH profile. For a new `DSH_HOME`, the simplest path is the shipped `web` profile:

   ```bash
   dsh plugin --profile web add /path/to/dsh-mattermost
   ```

   For another profile, replace `web`. A newly initialized profile that will serve the Web UI must include `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` in `dsh.profile.bundles`.

   Manual alternative for development:

   ```bash
   dsh plugin --profile web list   # initialize the profile
   mkdir -p "$DSH_HOME/profiles/web/node_modules"
   ln -s /path/to/dsh-mattermost "$DSH_HOME/profiles/web/node_modules/dsh-mattermost"
   # append "dsh-mattermost" to dsh.profile.bundles in profiles/web/package.json
   ```

3. The plugin's own `cordis.patch.yml` inserts its loader row. Override its `config` from the profile's `cordis.patch.yml` if you want profile-specific values (see below).

4. Restart DSH Web so the profile is re-read.

5. Verify activation:

   ```bash
   tail -n 20 "$DSH_HOME/mattermost/plugin.log"
   dsh --profile web --dump-config | grep -A2 'dsh-mattermost'
   ```

   Look for `apply() entered`, `web approval routing enabled=no`, and no `failed to import` / `ERR_MODULE_NOT_FOUND`. If credentials are missing, the plugin waits and logs why instead of taking DSH down.

### Troubleshooting installation

- `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`: step 1 was skipped or failed. Run `pnpm install --prod --ignore-scripts` in the checkout.
- `Cannot find package '@deepseek-ai/dsh-*'`: the DSH host is not 0.2.1-rc.2, or it does not supply the declared peers. Install the matching DSH release.
- The plugin row is absent from `--dump-config`: it is not in `dsh.profile.bundles`; add it.
- `failed to import` with another module: run the clean-install smoke test and include the full log.

### Clean-install smoke test

`feature-test/clean-install-smoke.sh` creates a temporary `DSH_HOME`, installs the checkout with the commands above, boots DSH, and asserts the plugin row activates with Web Approval off. It needs `dsh`, `pnpm`, and registry access; it never reads production config or credentials.

Known limits: the live Mattermost E2E and scheduler suites need an isolated Mattermost instance; the smoke test deliberately does not connect to one.

---

## Configuration

Every field below is read from the plugin's `Config` schema. All keys are optional and have defaults.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | string | `''` | Mattermost server base URL. |
| `tokenRef` | string | `'MATTERMOST_TOKEN'` | Name of the credential reference to resolve. |
| `token` | string (secret) | `''` | Inline token. Prefer the credential store instead. |
| `cwd` | string | `''` | Working directory for agents created by this plugin. |
| `channels` | string[] | `[]` | Channel allowlist. Empty means every channel the bot is in. |
| `freeResponseChannels` | string[] | `[]` | Channels that respond without an `@mention`. Keep empty in production. |
| `requireMention` | boolean | `true` | Require an `@mention` in channels. |
| `allowedUsers` | string[] | `[]` | Authorized Mattermost user ids. |
| `allowAll` | boolean | `false` | Accept all users. Development only. |
| `allowBotMentions` | boolean | `true` | Allow bot-authored posts to trigger. |
| `botChainMax` | number | `5` | Consecutive bot-triggered exchanges allowed per channel. |
| `botChainWindowMs` | number | `120000` | Quiet period after which the bot budget resets. |
| `idleAgentTtlMs` | number | `1800000` | Idle time before a live agent is released. |
| `idleSweepIntervalMs` | number | `60000` | How often the idle sweep runs. |
| `stateDir` | string | `''` | State directory. Empty means `$DSH_HOME/mattermost`. |
| `backfill` | boolean | `true` | Catch up on missed posts after a reconnect. |
| `maxReplyChars` | number | `12000` | Maximum characters per outbound message before splitting. |
| `approvalEnabled` | boolean | `true` | Answer native approval requests from Mattermost. `false` makes every request fall through to the next answerer (the Web UI), exactly as before. It never overrides DSH's own policy. |
| `approvalTimeoutMs` | number | `300000` | How long a posted approval card may stay open. An unanswered card resolves `unavailable`, i.e. the action is denied. |
| `webApproval` | object | all off | Where an approval raised by a DSH **Web** session may be announced. Empty `approvers` = off; actionable cards are one-to-one DM only. See *Web-origin approval notifications*. |
| `approvalCardArguments` | string | `off` | `off` hides the tool arguments on **Web-origin** cards; `masked` shows them masked. Mattermost-origin cards are unchanged. |
| `navigatorLimit` | number | `8` | How many sessions of the current conversation `/sessions` prints. |
| `bots` | object[] | `[]` | Additional bot accounts. Empty means the flat fields above describe the only bot. See [Multiple bots](#multiple-bots). |
| `debug` | boolean | `false` | Verbose adapter logging. |

### Example

Written into your DSH profile's `cordis.patch.yml`, this replaces the plugin row's whole config:

```yaml
- id: mattermost
  name: dsh-mattermost
  config:
    baseUrl: "<YOUR_MATTERMOST_URL>"
    tokenRef: MATTERMOST_TOKEN
    cwd: "/path/to/your/workspace"

    channels:
      - "<YOUR_CHANNEL_ID>"
    freeResponseChannels: []
    requireMention: true

    allowedUsers:
      - "<YOUR_USER_ID>"
    allowAll: false

    allowBotMentions: true
    botChainMax: 5
    botChainWindowMs: 120000

    idleAgentTtlMs: 1800000
    idleSweepIntervalMs: 60000

    backfill: true
    maxReplyChars: 12000
    debug: false
```

The bundled `cordis.patch.yml` also reads several values from `MATTERMOST_*` environment variables, which is convenient for container or service deployments.

### Credentials

Token resolution order:

1. an inline `token` in the plugin config, if set;
2. the DSH credential store, via `ctx.credentials.resolve(credentialRef(tokenRef))`;
3. the environment variable named by `tokenRef` (for example `MATTERMOST_TOKEN`).

The DSH credential store is the recommended option: the secret stays out of configuration files, and rotating it takes effect without editing config.

> Never commit Mattermost credentials to the repository.

The provider loads its store asynchronously during startup, so the adapter waits (up to 60 seconds) for the credential to resolve before giving up and staying idle.

---

## Usage

### Normal message

Mention the bot in an allowed channel, or send it a direct message:

```
@dsh hello
```

```
@dsh analyze this file
```

Messages in the same channel share one continuous session.

### Threads

Reply in a thread to work in an isolated session:

```
Root message
└── @dsh analyze this module     ← its own session
```

Start another thread for unrelated work; the two never share context.

### `/task`

Start an independent task session:

```
/task analyze the current project
```

The task gets its own session, separate from the surrounding channel conversation.

### `/steer`

Redirect a task that is currently running:

```
/steer focus on the authentication failure
```

Without `/steer`, new messages to a busy session are queued rather than injected.

### `/stop`

Request cancellation of the current turn:

```
/stop
```

### `/new`

Start a fresh conversation for the current chat:

```
/new
```

`/new` advances the conversation to its next generation. The previous sessions are kept — they
remain resumable and reachable through `/switch`.

### `/sessions` and `/session`

List this conversation's own sessions, and show the one you are in:

```
/sessions
/session
```

Only sessions this conversation created are listed: other threads, other users and other bots
are never scanned or shown, and DSH Web sessions are never touched.

### `/switch`

Point this conversation at one of its earlier sessions:

```
/switch 1              # by index, as printed by /sessions
/switch mm-1a2b3c4d    # by session id prefix
```

A switch only rewrites this conversation's mapping. It is refused while the current or the target
session has a turn in flight, and it can never make two conversations share one live agent.

### Approvals

When the agent asks for permission to do something outside its sandbox, the request is posted as a
card in the conversation. Answer it in either way:

```
(add ✅ to the card)         approve this one request
(add ❌ to the card)         reject it
/approve 1a2b3c4d             approve by id
/reject 1a2b3c4d              reject by id
/approvals                    list what is still pending here
```

Only a user authorized for that bot, in the channel where the request was posted, can decide, and
only once. Everything else — an expired card, a duplicate click, an unreachable Mattermost, an
ambiguous state — leaves the request **denied**.

The card shows the tool, the reason, the originating session, and the tool's arguments where they
can be recovered from the session log — masked (credentials removed) and truncated to 800
characters. The arguments are shown for context only; they are never used as an authorization
input, and they are never written to the plugin log.

A decision is refused with one of these codes, and none of them is retried automatically:

| Code | Meaning |
| --- | --- |
| `unknown` | No such request (a forged id, or one this process never saw). |
| `settled` | Already decided — the first answer wins. |
| `expired` | Past its deadline; the request is closed as `unavailable`. |
| `forbidden` | Wrong bot for this request, or a Web-origin card that is not a one-to-one DM. |
| `not-allowed` | Not authorized for that bot, or not the single configured approver of a Web-origin request. |
| `wrong-channel` | The decision came from a conversation other than the one the card lives in. |
| `not-posted` | No card was ever delivered for this request (e.g. the Web notification failed). |

Pending approvals live in this process only. After a plugin restart they are gone: cards that are
still visible in Mattermost become **orphans** — no reaction or command can decide them any more,
and they cannot collide with a newer request.

#### Web-origin approval notifications — one-to-one DM only

A request raised by a DSH **Web** session is answered by the browser prompt, and that remains the
primary entry point. This plugin may additionally announce it in Mattermost, under one rule:

> **An actionable card may only be delivered to a verified one-to-one DM whose single peer is the
> single configured approver.**

```yaml
webApproval:
  channel: ''        # P1  fixed conversation (channel id, ch: or dm: key)
  binding: {}        # P2  { botId: chatKey } — explicit conversation
  auto: false        # P3  single-user inference
  ttlMs: 86400000    # 24h — how old a conversation may be and still be used
  approvers: []      # the ONE user allowed to decide a Web-origin request

approvalCardArguments: 'off'   # 'off' (default) or 'masked' — Web cards only
```

The order is fixed: fixed conversation, then per-bot binding, then inference, then nothing. A broken
explicit destination stops the route — it never falls back to a guess, never broadcasts and never
creates a DM.

Whether a conversation is "one-to-one" is decided from the Mattermost **channel record and its member
list**, never from the `dm:` key prefix: a group DM (`type: G`) and a DM that gained a third member
are both possible. The resulting modes are:

| Destination | Result |
| --- | --- |
| verified 1:1 DM, peer = the approver | **actionable card** (✅ / ❌ / `/approve <id>`) |
| channel, group DM, thread | **notice only** — no request id, no tool name, no arguments, no way to decide |
| several approvers, peer ≠ approver, unreadable membership | **nothing** |

A card delivery failure never decides the request: the browser prompt keeps working, and the record
simply expires if nobody answers. If the browser answers first, the card is rewritten as void.

`approvers` must be a subset of `allowedUsers`. A configuration that reaches beyond it is rejected
at startup and the feature stays off. A destination is not a permission: landing a card in a
conversation grants nobody the right to answer it.

Mattermost-origin cards are **not** affected by any of this: they keep their existing behaviour,
including masked arguments and their channel/thread placement.

---

## Multiple Bots

One plugin instance can drive several Mattermost bot accounts. Each bot gets its own token
reference, WebSocket connection, reconnect loop, dedup/backfill state file, authorization set,
channel allowlist and session-key namespace.

```yaml
- id: mattermost
  name: dsh-mattermost
  config:
    cwd: /srv/workspace
    # Flat fields remain the defaults every bot inherits.
    allowedUsers: ['<user-id>']
    bots:
      - id: dsh              # first bot: keeps the historical keys and state.json
        tokenRef: MATTERMOST_TOKEN
        channels: ['<channel-id>']
        freeResponseChannels: ['<channel-id>']
      - id: dsh-ops
        tokenRef: MATTERMOST_TOKEN_OPS
        channels: ['<ops-channel-id>']
        allowedUsers: ['<ops-user-id>']
```

Omitted fields inherit the flat configuration. Bot ids are restricted to `[A-Za-z0-9._-]` and must
be unique; a malformed or duplicated id fails the plugin at load rather than silently collapsing
two bots into one namespace.

### What is isolated

| Layer | Isolated? | How |
| --- | --- | --- |
| Credentials | Yes | One token reference per bot. |
| Transport | Yes | One WebSocket, reconnect loop and dedup/backfill cursor per bot; dropping one socket does not reconnect the others. |
| Session mapping | Yes | Durable keys are `b<botId>:<chatKey>` and the bot id is part of the session-id hash, so two bots in the same channel or thread never share a session. |
| Authorization | Yes | Each bot has its own `allowedUsers` / `allowAll` / channel allowlist. |
| Approvals | Yes | A request records the bot that owns the session; a decision from another bot is refused. |
| Delivery | Yes | Replies go out through the bot that owns the session. |
| Agent runtime | **No** | All bots run agents in the same DSH process with the same tool permissions, working directory and filesystem access. |

**This is routing and data isolation, not a security sandbox.** Multiple bots do not give their
users separate tool permissions or separate filesystems. Do not describe a multi-bot deployment as
one.

### Upgrading an existing single-bot deployment

Nothing to do. The first configured bot owns the pre-multi-bot namespace: a mapping stored under
the bare `<chatKey>` is still read, and is mirrored (never moved, never deleted) into
`b<botId>:<chatKey>` the first time it is used, preserving the session id, its generation and its
history. New conversations are written under the new namespace.

---

## GUI Integration

The plugin runs inside the DSH Web process, so a Mattermost conversation and the DSH Web GUI
**can** operate on the same DSH durable session — when they address the same session id.

```
Mattermost ──► session mm-…  ◄── DSH Web GUI (opened on that same session)
```

Two things this does **not** mean:

* **They are not automatically the same session.** A GUI session is whatever session you open
  in the GUI. Opening the GUI on a *different* session gives you two independent
  conversations; only an equal `sessionId` makes them shared. In particular, `mm-…` sessions
  typically live under **Ungrouped** in the sidebar, not under a workspace group.
* **Sharing applies to the live agent, which is process-local.** When a live agent exists for
  that session, both surfaces reach the *same* agent object. Once the agent has been
  idle-evicted (or the process restarted), the session is still there — with its full history
  — but the shared live object is gone until something resumes it.

So:

| Condition | Result |
|---|---|
| Same session id, live agent present | Mattermost and GUI drive one shared live agent |
| Same session id, no live agent | Same durable session; the next message from either surface resumes it |
| Different session ids | Two unrelated conversations, even in the same process |

You can start a task from Mattermost, open that same session in the GUI to watch it and read
its history, continue from the GUI, and go back to Mattermost — all against the same durable
session.

> This requires the Mattermost plugin and DSH Web to run in the same DSH Web process.

---

## Delayed Jobs

A delayed task must not depend on a live agent. `sleep 3600` inside an agent does: when the
agent is idle-evicted, its scope is disposed and the background process is reclaimed with it,
so the task silently disappears.

Delayed jobs are therefore **persisted independently of the live agent lifecycle**:

```
agent calls schedule_job
        │
        ▼
durable job  ──►  survives idle eviction, restart, WS loss, reboot
        │
        ▼
due  ──►  the session is resumed  ──►  agent.followup()  ──►  Mattermost
```

* **Storage** — `ctx.storageDomain` (`dsh-storage-json`): atomic, fsynced, zod-validated, one
  document per job.
* **Lifetime** — a job outlives any number of agent evictions and process restarts. The 04:00
  `dsh-web` restart (if configured) does not lose pending jobs.
* **Duplicate protection** — jobs are claimed atomically with a lease; completion is persisted
  only after the instruction is durably committed to the session inbox, and the followup
  message carries a deterministic id so the inbox rejects a re-delivery. Delivery is
  at-least-once with a documented, sub-millisecond duplicate window.
* **Catch-up** — a job whose time passed while the host was down runs on startup, drained in
  bounded batches so a long outage cannot cause a thundering herd.
* **Cancellation** — `cancel_job`; **listing** — `list_jobs`.
* **Scope** — jobs are fenced to the session that created them, and only Mattermost-mapped
  sessions can schedule deliverable work.

### Tools

| Tool | Purpose |
|---|---|
| `schedule_job` | schedule a `reminder` or `agent_followup` (`after_seconds` or `at`) |
| `list_jobs` | list this conversation's jobs |
| `cancel_job` | cancel a pending job |

### Limitations

* A `completed` job means *the instruction was durably delivered to the session*, not that the
  agent's work finished; the reply arrives through the normal conversation path.
* Not a cron: no recurring jobs and no cron syntax.
* Delivery is at-least-once — see the duplicate window above.
* Jobs execute on the host; a host that is fully powered off runs nothing until it returns.

---

## Fault Observability

The plugin does not pretend to know things it cannot. When a fault is detected it is
recorded **durably**, and when a human is needed the plugin says so in Mattermost.

### What is detected, and what it means

| Detection | Meaning | Automatic action |
|---|---|---|
| Job due, never delivered | nothing was sent | **requeued** — safe |
| Job not yet due across a restart | nothing was attempted | stays scheduled |
| Process stopped **after** delivery was attempted | **execution result unknown** | marked `unknown`, **never replayed**, notified |
| A turn was still running when the process stopped | work was cut off | notified, correlated to any job delivered into that turn |
| A job document was corrupt / schema-incompatible | that record was isolated | other jobs unaffected; notified |
| A notification could not be sent | it is still owed | retried until Mattermost accepts it |

The distinction that matters: a job is only marked `unknown` when there is **evidence a
delivery was attempted**. If the plugin can prove nothing was sent, it requeues; if it
cannot prove anything, it asks instead of guessing.

### Delivery semantics, stated honestly

`completed` means **the instruction was durably handed to the session inbox** — not that the
agent finished the work. There is a residual window where a process dies between "delivered"
and "completion recorded"; that window is **detected** and reported as `unknown`, but its
execution outcome is genuinely unknowable from inside the plugin. **Exactly-once is not
claimed.**

### Fault events

Faults live in their own domain (`mattermost_faults`), separate from jobs so a fault record
can never make a job unreadable. Each event carries:

* a **stable, deterministic id** — re-running recovery cannot produce duplicates;
* what the plugin can actually claim (`unknown` / `interrupted` / `isolated` / `informational`);
* the last **confirmed** state, the related session and job;
* whether a human is required;
* notification state (`pending` / `sent` / `failed`), and whether Mattermost accepted it.

Notifications are sent with the event id, so the same event is never announced twice, and
`sent` is recorded only on a successful response.

### What this does not do

* **It cannot report a fully dead process.** The plugin runs inside `dsh web`; if that process
  dies, the plugin cannot send anything. Detecting that needs systemd/journal-level
  monitoring, which is out of scope here.
* **It never auto-replays a task whose result is unknown.** That decision is left to you.
* **It does not fake a result.** `unknown` is a first-class outcome.


## MCP Integration

This plugin covers the **inbound** path: Mattermost messages reaching a DSH agent, and the agent's replies going back.

It deliberately does not expose agent-facing tools. If you want the agent to act on Mattermost on demand — reading history, searching, reacting, or sending to an arbitrary channel — pair it with an MCP server that wraps the Mattermost REST API.

The two layers are complementary:

| Layer | Direction | Nature |
| --- | --- | --- |
| `dsh-mattermost` (this plugin) | Mattermost → DSH, and replies back | Event-driven runtime |
| A Mattermost MCP server | DSH agent → Mattermost | On-demand tools |

---

## Limitations

Current, known limitations:

- **Text only.** Inbound attachments, images and files are not processed.
- **No reactions or interactive components.** The adapter neither reacts to nor sends them.
- **No streaming edits.** Replies are delivered as messages; there is no progressive message editing.
- **No WebSocket sequence replay.** Recovery uses REST backfill after reconnecting rather than replaying buffered events.
- **Live agents are process-local.** Restarting the DSH Web process ends the current in-flight turn. Durable session state survives and can be resumed, but the agent object does not.
- **Shared fault domain.** The plugin runs inside DSH Web. An unhandled failure in a plugin path is a failure in that process. All asynchronous paths are guarded, but the coupling is inherent to the design.
- **No application-level concurrency cap.** Concurrency is bounded by the host and the model provider.
- **Channel-level authorization only.** There is no per-user rate limiting.

---

## Development

The plugin is plain ESM JavaScript. There is no build step or bundler. It has one installed dependency (`@deepseek-ai/schemastery`) and six `@deepseek-ai/dsh-*` peers supplied by the DSH host; `node_modules` is not committed.

`package.json` declares a `dsh.bundle.patch` entry, which is what makes the package loadable as a DSH bundle:

```json
{
  "type": "module",
  "main": "index.js",
  "dependencies": { "@deepseek-ai/schemastery": "~3.18.5" },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "0.2.1-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.2",
    "@deepseek-ai/dsh-storage-domain": "0.2.1-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2",
    "@deepseek-ai/dsh-credentials": "0.2.1-rc.2",
    "@deepseek-ai/dsh-scope": "0.2.1-rc.2"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

There is no lint or build script in this repository. `scheduler-test/` holds a separate acceptance suite (with its own README) that runs against an isolated harness; it is not part of the plugin runtime.

### Deployment checks

`deploy/preflight.sh` and `deploy/verify.sh` are **read-only** checks for a production rollout. `preflight.sh` inspects configuration, the credential reference, the bot identity, pending approvals (full pagination across the whitelisted channels), the Git baseline and commit chain, an optional bundle and the service state. `verify.sh` checks the deployed commit, worktree, config hash, service stability, logs, identity and pending approvals. Both print `PASS`/`FAIL`/`UNKNOWN` and exit non-zero when anything is not `PASS`; they never merge, reset, restart or send Mattermost messages — those actions stay manual and explicitly authorized.

`deploy/tests/run-tests.sh` runs the isolated suite against a mock Mattermost and a scratch Git repository. Paths and profiles can be overridden with `AB_REPO`, `AB_CFG`, `AB_CRED` and `AB_LOG`.

### Layout

```
index.js        plugin entry: config, admission, commands, lifecycle
bots.js         bot-set resolution: flat config and bots[] are one model
mapping.js      chat key derivation and the durable chat → session map
agents.js       in-process agent resolution, resume/create, idle eviction
mattermost.js   Mattermost transport: WebSocket inbound, REST outbound
outbound.js     session/event → adapter delivery
approvals.js    approval bridge: card, state machine, idempotency, audit
navigator.js    session navigator: selection, rendering, switch guards
redact.js       display-time credential masking and truncation
markdown.js     reply splitting
cordis.patch.yml  bundle patch: the loader row and its default config
scheduler-test/   acceptance suite for durable jobs (isolated harness)
feature-test/     acceptance suite for approvals / navigator / multi-bot
```

### Contributing

- Keep session id derivation inside `mapping.js`. Nothing else should build a session id.
- Keep authorization ahead of anything that could create state — including deciding an approval.
- Answer approvals only for agents this plugin owns, and delegate every other request with `next()`.
- Prefer queueing over implicit interruption. `/steer` is the explicit path.
- Add a note here if you introduce a new configuration field.

---

## Production Notes

- Use a **dedicated Mattermost bot account**.
- Keep `allowAll: false` and list `allowedUsers` explicitly.
- List `channels` explicitly rather than leaving it empty.
- Keep `freeResponseChannels` empty unless you really want unmentioned replies.
- Keep `debug: false`.
- Store credentials outside the repository.
- Run the bot in the DSH Web process only.

> **Do not run a legacy external bridge and `dsh-mattermost` against the same Mattermost bot at the same time.**

Two consumers on one bot account means duplicate event consumption, duplicate replies, duplicate task execution and conflicting session ownership. Stop the previous bridge, confirm its process and WebSocket connection are gone, and only then enable this plugin.

The current baseline has been exercised with long-running tasks, concurrent sessions, reconnect recovery, authorization checks, thread isolation, GUI/session sharing, and idle-agent lifecycle tests. Detailed validation records are kept separately and are not part of this repository.

---

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 WillFunniers.
