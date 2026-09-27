# dsh-mattermost

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

This repository currently targets **source-based installation within DSH**. There is no published npm package, no build step, and no runtime dependency of its own — it resolves its DSH imports from the DSH installation.

1. Clone the repository somewhere stable:

   ```bash
   git clone https://github.com/WillFunniers/dsh-mattermost.git
   ```

2. Install it into a DSH profile. A profile is a directory under `$DSH_HOME/profiles/<name>` with a `package.json` and a `cordis.patch.yml`.

   Make the package resolvable from the profile and add it to the profile's bundle list:

   ```bash
   ln -s /path/to/dsh-mattermost $DSH_HOME/profiles/<profile>/node_modules/dsh-mattermost
   ```

   Then append `dsh-mattermost` to the `dsh.profile.bundles` array in `$DSH_HOME/profiles/<profile>/package.json`.

3. The plugin's own `cordis.patch.yml` inserts its loader row. Override its `config` from the profile's `cordis.patch.yml` if you want profile-specific values (see below).

4. Restart DSH Web so the profile is re-read.

After startup, the plugin logs its resolved configuration and connects:

```
ready (cwd=..., channels=..., allowedUsers=..., botChainMax=5, idleTtlMs=1800000)
websocket connected
```

If credentials are missing, the plugin stays idle and logs why instead of taking DSH down.

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

---

## GUI Integration

Because the plugin runs inside the DSH Web process, a session started from Mattermost is the same session the DSH Web GUI shows:

```
Mattermost
     │
     ▼
same DSH session
     │
     ▼
DSH Web GUI
```

You can start a task from Mattermost, open the GUI to watch it and read its history, continue the conversation from the GUI, and go back to Mattermost — all against the same live agent.

> This requires the Mattermost plugin and DSH Web to run in the same DSH Web process.

---

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

The plugin is plain ESM JavaScript. There is no build step, no bundler, and no runtime dependency of its own — imports of `@deepseek-ai/*` packages resolve from the DSH installation.

`package.json` declares a `dsh.bundle.patch` entry, which is what makes the package loadable as a DSH bundle:

```json
{
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

There is currently no test suite and no lint or build script in this repository.

### Layout

```
index.js        plugin entry: config, admission, commands, lifecycle
mapping.js      chat key derivation and the durable chat → session map
agents.js       in-process agent resolution, resume/create, idle eviction
mattermost.js   Mattermost transport: WebSocket inbound, REST outbound
outbound.js     session/event → adapter delivery
markdown.js     reply splitting
cordis.patch.yml  bundle patch: the loader row and its default config
```

### Contributing

- Keep session id derivation inside `mapping.js`. Nothing else should build a session id.
- Keep authorization ahead of anything that could create state.
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

No `LICENSE` file is present in this repository yet.

`package.json` currently declares `"license": "MIT"`, but the corresponding license text has not been added. Until a license file is committed, no license is granted.
