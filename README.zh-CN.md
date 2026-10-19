# dsh-mattermost

[English](./README.md) | **简体中文**

一个原生的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，把 Mattermost 变成 DSH agent 的任务入口。

`dsh-mattermost` 不是外部桥接进程：它**加载在 DSH Web 进程内部**，驱动一个同进程内的 agent。只要 DSH Web 进程在运行，Mattermost 与 DSH Web GUI 就在同一个进程里操作同一个活跃 agent/session。

```
Mattermost  ──WebSocket──▶  dsh-mattermost  ──▶  DSH Web 进程
                                                      │
                                                      ▼
                                                  活跃 Agent
                                                      ↕
                                                 DSH Session
                                                      ↕
                                                 DSH Web GUI
```

---

## 功能特性

- **Mattermost WebSocket 入站** —— 不轮询，插件自己持有连接。
- **同进程 agent** —— agent 在 DSH Web 进程内创建，不另起子进程。
- **与 GUI 共享活跃会话** —— 进程运行期间，Mattermost 与 DSH Web GUI 解析到同一个 agent 对象。
- **每线程独立会话** —— 每个 Mattermost 线程拥有自己隔离的对话。
- **`/task` 命令** —— 显式开启一个独立任务会话。
- **排队而非隐式打断** —— 发给忙碌会话的消息会作为后续消息排队。
- **显式转向** —— `/steer` 是改变已在运行之任务方向的唯一方式。
- **不绑定请求生命周期** —— 回复不依附于入站 WebSocket 帧或某个打开的 HTTP 请求。
- **重连恢复** —— WebSocket 重连 + REST 回补 + 去重。
- **投递韧性** —— 临时发送失败会重试；线程根不可用时可回退为频道消息。
- **空闲 agent 回收** —— 闲置一段时间后释放运行时 agent，同时保留持久化会话。
- **默认拒绝的授权模型** —— 用户与频道白名单。
- **机器人环路防护** —— 每频道预算限制机器人之间的往复。

---

## 架构

本插件是一个 Cordis 插件，导出 `name`、`inject`、`Config` 与 `apply(ctx, config)`。

它依赖 DSH 的 `agents` 与 `agentDefaultModel` 服务；若存在，还会读取 `credentials`、`agentPresets`、`sessionQuery` 与 `permissionPresets`。

```
Mattermost Server
      │  WebSocket（Bearer header 认证，应用层 ping）
      ▼
  mattermost.js ── 入站 post ──▶ index.js（准入 + 命令）
                                        │
                                        ▼
                                   mapping.js   chatKey → sessionId
                                        │
                                        ▼
                                   agents.js    复用活跃 agent
                                        │        sessionQuery.observeSession
                                        │        resume / create
                                        ▼
                                  DSH Session / 事件总线
                                        │
                        ┌───────────────┴────────────────┐
                        ▼                                ▼
                  outbound.js                      DSH Web GUI
              （session/event → REST 发送）    （同进程、同 agent）
```

### 为什么不做外部桥接？

|                              | `dsh-mattermost`                      | 外部桥接                            |
| ---------------------------- | ------------------------------------- | ----------------------------------- |
| 运行位置                     | DSH Web 进程内部                      | 独立进程                            |
| 活跃 agent                   | 与 DSH Web GUI 共享                   | 相互独立                            |
| GUI 与 Mattermost 同会话     | 进程运行期间可以                      | 天然做不到                          |
| 长任务与请求生命周期         | 不绑定 Mattermost 请求                | 取决于桥接实现                      |
| 会话归属                     | 同进程                                | 跨进程                              |
| Mattermost WebSocket         | 由插件持有                            | 由桥接进程持有                      |

两种设计都成立。选择这一种，是因为同进程 agent 消除了跨进程会话争用与进程生命周期限制；代价是与 DSH Web 共享同一个故障域。

---

## 会话模型

所有 session id 只在一处派生（`mapping.js`），来源是一个**会话键（chat key）**：

| 来源                            | 会话键                    |
| ------------------------------- | ------------------------- |
| 私聊（DM）                      | `dm:<channel_id>`         |
| 频道根消息                      | `ch:<channel_id>`         |
| 线程内回复                      | `th:<root_post_id>`       |
| 在频道根执行的 `/task`          | `th:<command_post_id>`    |

session id 是会话键的确定性函数，因此映射无需查表即可跨重启保持。磁盘上另有一份持久映射，用于记录会话元数据与 `/new` 的代次（generation）。

### 频道

频道根消息共享同一个会话，形成连续对话：

```
#channel
└── 根消息 ─────────────────────▶ 会话 A
```

### 线程

每个线程都是独立会话：

```
#channel
├── 根消息 ─────────────────────▶ 会话 A
├── 线程 1 ─────────────────────▶ 会话 B
└── 线程 2 ─────────────────────▶ 会话 C
```

在线程内回复始终使用该线程的会话，不同线程之间永不共享。

### `/task`

`/task <提示词>` 会开启一个**新**会话，适合长时间或相互独立的工作：

```
/task 分析当前项目
```

### `/new`

`/new` 提升当前会话键的代次，开启一段全新对话，同时把此前的会话保留在磁盘上。

---

## 并发

不同会话可并发运行。插件本身没有应用层并发上限，实际限制来自机器与模型提供方。

```
会话 A ───── 运行中
会话 B ───── 运行中
会话 C ───── 运行中
```

同一会话内，消息不会互相打断：

```
消息 1 ──▶ 运行中
消息 2 ──▶ followup() ──▶ 排队
```

**发给忙碌会话的消息会作为后续消息排队**，不会被合并进正在运行的任务。

`/steer <文本>` 是显式、需主动开启的转向机制，用于改变已在运行的任务方向。系统不会自动转向。

`/stop` 请求取消当前回合。

---

## 长任务

插件不使用入站 WebSocket 帧或打开的 HTTP 请求来维持任务存活。回复来自持久化会话的事件总线，因此任务可以运行得远比任何请求超时更久。

运行时的归属者仍然是 DSH Web 进程：

```
发送消息 ──▶ agent 运行 ──▶（可能持续很久）──▶ 回复
```

插件不施加固定的单任务超时。

但活跃 agent 是**进程本地**的：重启 DSH Web 进程会终止当前正在进行的回合。会话状态本身是持久化的 —— 对话已落盘、可恢复 —— 但 agent 对象无法跨越重启。

> 会话状态持久化；活跃 agent 是进程本地的，重启后可能需要重新恢复。

---

## 恢复

重连期间，适配器会尽力同时减少消息丢失与重复投递：

- **重连** —— 指数退避自动重连。
- **REST 回补** —— 重连后按上次已见时间戳拉取更新的帖子。
- **去重** —— 有界的已处理 post id 集合，避免同一条帖子被处理两次（例如实时一次、回补一次）。
- **投递重试** —— 临时发送失败按退避重试。
- **线程根回退** —— 若无法回复进线程（例如线程根已不存在），则改为发到频道，而不是丢弃。

这些机制降低丢失与重复，但**不构成正式的恰好一次（exactly-once）保证**。

---

## 空闲回收

活跃 agent 在其存在期间会占用运行时资源，因此插件区分两件事：

```
持久化会话   ≠   活跃 agent 对象
```

闲置超过 `idleAgentTtlMs` 后，清扫器会释放运行时 agent：

```
活跃 agent ──闲置超过 TTL──▶ 释放运行时
                                  │
持久化会话仍保留 ◀─────────────────┘
                                  │
将来消息 ──▶ sessionQuery.observeSession ──▶ resume
```

agent 在运行中、正在创建中、或近期有活动时**永远不会**被回收。清扫按 `idleSweepIntervalMs` 周期执行。

---

## 安全

授权采用**默认拒绝**。

- `allowedUsers` —— 允许使用机器人的 Mattermost 用户 id。
- `allowAll` —— 设为 `true` 接受所有人（仅限开发）。
- `channels` —— 可选频道白名单。为空表示机器人所在的所有频道。
- `freeResponseChannels` —— 无需 `@提及` 即可响应的频道。

当 `allowAll: false` 且 `allowedUsers` 为空时，**任何人都不会被接受**。

**未授权用户会在会话/agent/工作区创建之前被拒绝**：未授权的帖子不会生成会话、不会创建 agent、也不会产生回复，只会记录一条告警：

```
unauthorized inbound userId=<id> channelId=<id> reason=unauthorized
```

机器人也永远不会响应用自己的帖子。

### 机器人环路防护

两个会互相自动回复的机器人可能无限往复：

```
机器人 ──▶ 插件 ──▶ 回复 ──▶ 另一个机器人 ──▶ 插件 ──▶ ...
```

适配器用每频道预算加以限制：

- `allowBotMentions` —— 是否允许机器人发布的帖子触发。
- `botChainMax` —— 每频道允许的连续机器人触发次数。
- `botChainWindowMs` —— 静默一段时间后预算重置。

机器人帖子必须显式指向本机器人（`@提及` 或私聊）才会触发；无关的机器人闲聊会被忽略。频道内任何人类消息也会重置该频道的预算。

### 凭据

切勿把 Mattermost 凭据提交到仓库。请通过 DSH 凭据库或环境变量提供 token，详见[配置](#配置)。

---

## 安装

本仓库目前面向 **DSH 内的源码安装**：没有发布 npm 包，没有构建步骤，也没有自身运行时依赖 —— 它的 DSH 导入都从 DSH 安装中解析。

1. 克隆到固定位置：

   ```bash
   git clone https://github.com/WillFunniers/dsh-mattermost.git
   ```

2. 安装到某个 DSH profile。profile 是 `$DSH_HOME/profiles/<name>` 下的一个目录，含 `package.json` 与 `cordis.patch.yml`。

   让包可从该 profile 解析，并加入 profile 的 bundle 列表：

   ```bash
   ln -s /path/to/dsh-mattermost $DSH_HOME/profiles/<profile>/node_modules/dsh-mattermost
   ```

   然后在 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 数组中追加 `dsh-mattermost`。

3. 插件自带的 `cordis.patch.yml` 会插入自己的 loader 行。若要写入 profile 专属配置，从 profile 的 `cordis.patch.yml` 覆盖其 `config`（见下）。

4. 重启 DSH Web，使 profile 被重新读取。

启动后，插件会打印解析后的配置并连接：

```
ready (cwd=..., channels=..., allowedUsers=..., botChainMax=5, idleTtlMs=1800000)
websocket connected
```

若凭据缺失，插件会保持待机并说明原因，而不会拖垮 DSH。

---

## 配置

以下字段均来自插件的 `Config` schema，全部可选且有默认值。

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `baseUrl` | string | `''` | Mattermost 服务器基础 URL。 |
| `tokenRef` | string | `'MATTERMOST_TOKEN'` | 要解析的凭据引用名。 |
| `token` | string（secret） | `''` | 内联 token。请优先使用凭据库。 |
| `cwd` | string | `''` | 本插件创建的 agent 的工作目录。 |
| `channels` | string[] | `[]` | 频道白名单。为空表示机器人所在的所有频道。 |
| `freeResponseChannels` | string[] | `[]` | 无需 `@提及` 即响应的频道。生产环境请保持为空。 |
| `requireMention` | boolean | `true` | 频道内是否必须 `@提及`。 |
| `allowedUsers` | string[] | `[]` | 已授权的 Mattermost 用户 id。 |
| `allowAll` | boolean | `false` | 接受所有用户。仅限开发。 |
| `allowBotMentions` | boolean | `true` | 是否允许机器人发布的帖子触发。 |
| `botChainMax` | number | `5` | 每频道允许的连续机器人触发次数。 |
| `botChainWindowMs` | number | `120000` | 机器人预算重置的静默期。 |
| `idleAgentTtlMs` | number | `1800000` | 释放活跃 agent 前的闲置时长。 |
| `idleSweepIntervalMs` | number | `60000` | 空闲清扫的执行间隔。 |
| `stateDir` | string | `''` | 状态目录。为空表示 `$DSH_HOME/mattermost`。 |
| `backfill` | boolean | `true` | 重连后是否回补错过的帖子。 |
| `maxReplyChars` | number | `12000` | 单条出站消息的最大字符数，超出则拆分。 |
| `debug` | boolean | `false` | 输出更详细的适配器日志。 |

### 示例

写入 DSH profile 的 `cordis.patch.yml`，会整体替换插件行的配置：

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

随附的 `cordis.patch.yml` 还会从若干 `MATTERMOST_*` 环境变量读取配置，便于容器或服务化部署。

### 凭据

token 解析顺序：

1. 插件配置中的内联 `token`（若已设置）；
2. DSH 凭据库，经 `ctx.credentials.resolve(credentialRef(tokenRef))`；
3. 由 `tokenRef` 命名的环境变量（例如 `MATTERMOST_TOKEN`）。

推荐使用 DSH 凭据库：密钥不进入配置文件，轮换无需改配置即可生效。

> 切勿把 Mattermost 凭据提交到仓库。

凭据提供方在启动期间异步加载存储，因此适配器会等待（最多 60 秒）凭据解析，超时后保持待机。

---

## 使用

### 普通消息

在允许的频道中 `@提及` 机器人，或直接给它发私聊：

```
@dsh 你好
```

```
@dsh 分析这个文件
```

同一频道内的消息共享一段连续会话。

### 线程

在线程内回复，即在隔离会话中工作：

```
根消息
└── @dsh 分析这个模块     ← 它自己的会话
```

为不相关的工作另开线程；两者永不共享上下文。

### `/task`

开启一个独立任务会话：

```
/task 分析当前项目
```

该任务拥有自己的会话，与所在频道的对话相互分离。

### `/steer`

改变当前正在运行任务的方向：

```
/steer 聚焦到认证失败的问题上
```

不使用 `/steer` 时，发给忙碌会话的新消息只会排队，而不会被注入。

### `/stop`

请求取消当前回合：

```
/stop
```

### `/new`

为当前会话开启一段全新对话：

```
/new
```

---

## 与 GUI 的集成

插件运行在 DSH Web 进程内部，因此 Mattermost 对话与 DSH Web GUI **可以**操作同一个 DSH 持久化会话 —— 前提是它们指向同一个 session id。

```
Mattermost ──► 会话 mm-…  ◄── DSH Web GUI（打开到同一个会话）
```

这**不代表**两件事：

* **它们不会自动成为同一个会话。** GUI 会话就是你在此 GUI 中打开的那个会话。在**另一个**会话上打开 GUI，得到的是两段独立对话；只有 `sessionId` 相同才会共享。特别地，`mm-…` 会话通常位于侧边栏的 **Ungrouped** 下，而不在工作区分组中。
* **共享的是活跃 agent，而它是进程本地的。** 当该会话存在活跃 agent 时，两个界面触达的是**同一个** agent 对象。一旦 agent 被空闲回收（或进程重启），会话仍然存在 —— 连同完整历史 —— 但共享的活跃对象已消失，直到有东西将其恢复。

因此：

| 条件 | 结果 |
|---|---|
| 相同 session id，存在活跃 agent | Mattermost 与 GUI 驱动同一个共享活跃 agent |
| 相同 session id，无活跃 agent | 同一个持久化会话；任一界面下条消息都会将其恢复 |
| 不同 session id | 两段无关对话，即使在同进程内 |

你可以从 Mattermost 发起任务，在 GUI 中打开同一会话观察并阅读历史，从 GUI 继续，再回到 Mattermost —— 全程针对同一个持久化会话。

> 这要求 Mattermost 插件与 DSH Web 运行在同一个 DSH Web 进程内。

---

## 延迟任务（定时任务）

延迟任务不能依赖活跃 agent。在 agent 内部 `sleep 3600` 恰恰依赖了它：agent 被空闲回收时，其作用域被销毁，后台进程一并被回收，任务于是静默消失。

因此延迟任务**独立于活跃 agent 生命周期持久化**：

```
agent 调用 schedule_job
        │
        ▼
持久化任务  ──►  可跨空闲回收、重启、WebSocket 断开、重启主机
        │
        ▼
到期  ──►  恢复会话  ──►  agent.followup()  ──►  Mattermost
```

* **存储** —— `ctx.storageDomain`（`dsh-storage-json`）：原子、fsync、zod 校验，每个任务一个文档。
* **生命周期** —— 任务可跨越任意次 agent 回收与进程重启。04:00 的 `dsh-web` 重启（若配置）不会丢失待办任务。
* **重复保护** —— 任务以租约方式原子认领；只有在指令已持久写入会话收件箱后才记录完成，且 followup 消息携带确定性 id，使收件箱拒绝重复投递。投递语义为**至少一次**，并有一个已文档化的、亚毫秒级重复窗口。
* **追赶** —— 主机停机期间到期的任务会在启动时补跑，并以有界批次排空，避免长时间中断造成惊群。
* **取消** —— `cancel_job`；**列举** —— `list_jobs`。
* **作用域** —— 任务被围栏在创建它的会话内，且只有与 Mattermost 映射的会话才能调度可投递的工作。

### 工具

| 工具 | 用途 |
|---|---|
| `schedule_job` | 调度一个 `reminder` 或 `agent_followup`（`after_seconds` 或 `at`） |
| `list_jobs` | 列出本对话的任务 |
| `cancel_job` | 取消一个待办任务 |

### 限制

* 任务 `completed` 的含义是**指令已持久投递到会话**，而不是 agent 的工作已完成；回复通过正常对话路径到达。
* 不是 cron：不支持周期任务，也不支持 cron 语法。
* 投递为至少一次 —— 见上文重复窗口。
* 任务在主机上执行；主机完全断电期间不会运行任何东西，直到恢复。

---

## 故障可观测性

插件不假装知道自己不知道的事。检测到故障时会**持久化**记录；需要人工介入时，插件会在 Mattermost 里说出来。

### 检测到什么，以及它的含义

| 检测情形 | 含义 | 自动动作 |
|---|---|---|
| 任务到期但从未投递 | 什么都没发出 | **重新排队** —— 安全 |
| 任务在重启期间尚未到期 | 尚未尝试任何投递 | 保持已调度 |
| 进程在**尝试投递之后**停止 | **执行结果未知** | 标记为 `unknown`，**永不重放**，并通知 |
| 进程停止时仍有回合在运行 | 工作被切断 | 通知，并与投递进该回合的任务关联 |
| 任务文档损坏 / schema 不兼容 | 该记录已被隔离 | 其他任务不受影响；通知 |
| 通知发送失败 | 通知仍然欠着 | 重试直到 Mattermost 接受 |

关键区别：只有当**存在投递曾被执行过的证据**时，任务才会被标记为 `unknown`。若插件能证明什么都没发，就重新排队；若无法证明，就询问而不是猜测。

### 投递语义（如实陈述）

`completed` 表示**指令已持久交给会话收件箱** —— 不代表 agent 完成了工作。存在一个残余窗口：进程在"已投递"与"已记录完成"之间死亡；该窗口会被**检测到**并报告为 `unknown`，但其执行结果从插件内部确实无从得知。**本插件不宣称恰好一次（exactly-once）。**

### 故障事件

故障存放在独立域（`mattermost_faults`）中，与任务分离，因此故障记录绝不会让任务变得不可读。每个事件携带：

* **稳定、确定性的 id** —— 重跑恢复不会产生重复；
* 插件真正能断言的内容（`unknown` / `interrupted` / `isolated` / `informational`）；
* 最后一次**已确认**的状态、相关会话与任务；
* 是否需要人工介入；
* 通知状态（`pending` / `sent` / `failed`），以及 Mattermost 是否接受。

通知携带事件 id，因此同一事件不会被播报两次；只有成功响应才会记录 `sent`。

### 它做不到什么

* **无法报告一个完全死掉的进程。** 插件运行在 `dsh web` 内部；该进程死亡时插件无法发出任何东西。要检测这种情况需要 systemd/journal 级别监控，超出本插件范围。
* **永不自动重放结果未知的任务。** 该决定留给你。
* **不伪造结果。** `unknown` 是一等公民结局。

---

## MCP 集成

本插件覆盖**入站**路径：Mattermost 消息到达 DSH agent，以及 agent 的回复发回。

它刻意不暴露面向 agent 的工具。若希望 agent 按需操作 Mattermost —— 读历史、搜索、加表情、向任意频道发送 —— 请搭配一个封装 Mattermost REST API 的 MCP 服务器。

两层是互补的：

| 层 | 方向 | 性质 |
| --- | --- | --- |
| `dsh-mattermost`（本插件） | Mattermost → DSH，以及回复返回 | 事件驱动运行时 |
| Mattermost MCP 服务器 | DSH agent → Mattermost | 按需工具 |

---

## 已知限制

当前已知限制：

- **仅文本。** 入站附件、图片与文件不会被处理。
- **无表情回应与交互组件。** 适配器既不加也不发。
- **无流式编辑。** 回复以消息形式投递，没有渐进式消息编辑。
- **无 WebSocket 序列重放。** 恢复采用重连后的 REST 回补，而不是重放缓冲事件。
- **活跃 agent 是进程本地的。** 重启 DSH Web 进程会终止当前进行中的回合。持久化会话状态仍可恢复，但 agent 对象不行。
- **共享故障域。** 插件运行在 DSH Web 内部，插件路径上的未处理失败即该进程的失败。所有异步路径都有防护，但这种耦合是设计本身带来的。
- **无应用层并发上限。** 并发受主机与模型提供方约束。
- **仅频道级授权。** 没有按用户的速率限制。

---

## 开发

插件是纯 ESM JavaScript：没有构建步骤、没有打包器、自身没有运行时依赖 —— 对 `@deepseek-ai/*` 包的导入从 DSH 安装中解析。

`package.json` 声明了 `dsh.bundle.patch` 条目，这才使该包可作为 DSH bundle 加载：

```json
{
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

仓库内没有 lint 或 build 脚本。`scheduler-test/` 存放一套独立的验收套件（自带 README），针对隔离的测试 harness 运行，不属于插件运行时。

### 目录结构

```
index.js       插件入口：配置、准入、命令、生命周期
mapping.js     会话键派生与持久化 chat → session 映射
agents.js      同进程 agent 解析、恢复/创建、空闲回收
mattermost.js  Mattermost 传输：WebSocket 入站、REST 出站
outbound.js    session/event → 适配器投递
markdown.js    回复拆分
cordis.patch.yml  bundle 补丁：loader 行及其默认配置
scheduler-test/   验收套件（隔离 harness；见其自带 README）
```

### 贡献约定

- session id 的派生只放在 `mapping.js`，其他任何地方都不应构造 session id。
- 授权检查要始终位于任何可能创建状态的逻辑之前。
- 优先排队，而非隐式打断；`/steer` 是显式路径。
- 若新增配置字段，请同步更新此处文档。

---

## 生产注意事项

- 使用**专用的 Mattermost 机器人账号**。
- 保持 `allowAll: false`，并显式列出 `allowedUsers`。
- 显式列出 `channels`，不要留空。
- 除非确实想要无提及回复，否则保持 `freeResponseChannels` 为空。
- 保持 `debug: false`。
- 凭据存放在仓库之外。
- 只在 DSH Web 进程内运行该机器人。

> **切勿让旧的外部桥接与 `dsh-mattermost` 同时对同一个 Mattermost 机器人运行。**

一个机器人账号上的两个消费者意味着重复的事件消费、重复的回复、重复的任务执行，以及冲突的会话归属。请先停掉旧桥接，确认其进程与 WebSocket 连接都已消失，再启用本插件。

当前基线已在长任务、并发会话、重连恢复、授权检查、线程隔离、GUI/会话共享以及空闲 agent 生命周期等场景下验证。详细验证记录单独保存，不属于本仓库。

---

## 许可证

本仓库包含 `LICENSE` 文件：**MIT License**，Copyright (c) 2026 WillFunniers，与 `package.json` 中的 `"license": "MIT"` 一致。

允许在 MIT 条款下使用、复制、修改、合并、发布、分发、再许可和/或销售本软件的副本，条件是保留上述版权声明与许可声明。
