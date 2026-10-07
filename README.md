# codex-supervisor-mcp

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

让一个主线程（Claude Code、Codex、任何 MCP 客户端）同时指挥多个 Codex worker 干活。

![演示：一个 Claude Code 主线程同时派 3 个 Codex worker，各自独立 worktree，并行跑完后合并提交](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 秒演示（真跑，非摆拍）：Claude Code 主线程 `create_codex_worker` ×3 → 三个 worker 在各自 worktree 里并行干活 → 主线程收 3 份 diff 合并成一次 commit。*

一个 worker 一个独立 Git worktree，一个 worker 一个原生 Codex goal，状态全部落盘。主线程负责派单、等待、读结果、断线重连、取消。

## 它解决什么

直接让多个 agent 同时改一个仓库，结果是互相覆盖、没人知道谁改了什么。这个 MCP 把「派单」和「记账」从模型上下文里拿出来，落到磁盘上：

| 问题 | 做法 |
|---|---|
| 多个 worker 互相踩文件 | 每个 worker 一个 Git worktree；`ownedPaths` 在派单前做冲突检测 |
| 主线程上下文塞不下 worker 的过程 | 事件流写 `data/runs/<taskId>.jsonl`；读事件有 `limit` / `maxChars` / `kinds` 三个闸门 |
| 主线程读一次就被顶爆上下文 | `get_orchestration_overview` 把全部 worker 压到 2k token 以内 |
| 进程重启后不知道谁还在跑 | `supervisor.sqlite` 里一行一个 work 快照，含 `thread_id` |
| 换个会话就接不上之前的 worker | `resume_codex_worker` 走 `codex exec resume <thread_id>`，接的是同一个 Codex 会话 |
| 分不清「跑失败了」和「进程没了」 | 状态机把 `failed` 和 `lost` 分开 |

## 和 Claude Code 的 subagent 有什么区别

先说一条已经不是差异的：Claude Code 的 subagent 现在能自己开 worktree 了（`isolation: worktree`，见 [官方 worktrees 文档](https://docs.claude.com/en/docs/claude-code/worktrees) 里的 "Isolate subagents with worktrees"）。文件隔离这件事官方已经做了，别为了这个装本插件。

真正的差别在模型。subagent 的 `model` 字段只能填 Claude 的别名或完整 Claude 模型 ID（`sonnet` / `opus` / `haiku` / `inherit`），DeepSeek 这类非 Claude 模型填不进去，账单也全走 Anthropic 的价目表，派三个就是三份。

派出去的是 `codex exec` 子进程，`model` 参数原样透传给 Codex CLI（`src/codex-runner.js:336`）。worker 用什么模型跟主线程没关系：主线程留在 Claude 上做判断，worker 可以挂 DeepSeek，在 Codex 的 `config.toml` 里配好 provider 就行。重活都在 worker 那边，主线程读的是 `get_orchestration_overview` 那张表，要看 diff 自己去 worker 的 worktree 里取。

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| 能跑什么模型 | 只能选 Claude：别名或完整 Claude 模型 ID | `model` 透传给 Codex CLI，DeepSeek 也能挂 |
| 干活的是谁 | Claude Code 自己 | 独立的 `codex exec` 进程 |
| 工作目录 | 默认和主线程同一个，可设 `isolation: worktree` | 一个 worker 一个 Git worktree |
| 两个 worker 写同一个文件 | 靠 worktree 隔开，没有路径声明和冲突检查 | 派单前求 `ownedPaths` 交集，重叠就不建 worktree，报 `ownership_conflict` |
| 主线程上下文 | subagent 的结果回到主线程 | 事件写 `data/runs/<taskId>.jsonl`，总览走 7000 字节硬预算（`src/mcp-server.js:32`） |
| 主线程进程挂了 | worker 一起没 | `thread_id` 落 sqlite，`resume_codex_worker` 接回同一个会话 |
| 谁能驱动 | 只有 Claude Code | 任意 MCP 客户端 |
| 看 worker 干活的过程 | 只有它返回的结论 | 原始 JSONL 按 `kinds` / `limit` / `maxChars` 读 |

## 架构

```
MCP client (Claude Code / Codex / ...)
   │  stdio (MCP)
   ▼
codex-supervisor-mcp
   │  spawn: codex exec --json
   ▼
Codex worker  ──►  data/runs/<taskId>.jsonl      原始 JSONL 事件流
              ──►  supervisor.sqlite              tasks + task_events
              ──►  worktrees/<taskId>/            独立 Git worktree
```

## 安装

前置：**Node.js >= 22.13.0**（`node:sqlite` 在这个版本之前没有无 flag 的构建）和 `codex` CLI 在 `PATH` 里。macOS、Linux、Windows 都支持。

### 快速开始

```bash
# 1. 装
npm install -g codex-supervisor-mcp

# 2. 确认挂上了
claude mcp list | grep codex-supervisor
codex mcp list  | grep codex-supervisor
```

全局安装的 `postinstall` 会自动做两件事，**不需要手动配置**：

1. 把配套 skill 装进检测到的客户端目录：`~/.claude/skills/`、`~/.agents/skills/`、`~/.codex/skills/`。
2. 用客户端自带的 CLI 注册 MCP：`claude mcp add -s user` / `codex mcp add`，注册的是 `node <包内绝对路径>`。

skill 已存在且内容不同时，先写一份 `SKILL.md.bak-<时间戳>` 再覆盖。任何一步失败都不会让安装失败。

### 手动挂载

`postinstall` 没跑到（`--ignore-scripts`、`npx`、pnpm 之类）时，自己补一条：

| 客户端 | 命令 |
|---|---|
| Claude Code | `claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp` |
| Codex | `codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp` |

重跑、修复、只装某一个客户端，或者先看它打算干什么：

```bash
codex-supervisor-setup                      # 自动检测客户端，补装 skill + 注册 MCP
codex-supervisor-setup --target claude,codex
codex-supervisor-setup --skill-only         # 只装 skill，不碰 MCP 配置
codex-supervisor-setup --mcp-only           # 只注册 MCP，不装 skill
codex-supervisor-setup --dry-run            # 只打印计划，不改任何东西
```

### 挂到 GUI 客户端

自己建/改下面的配置文件，加这一段（GUI 客户端不会跑 `postinstall`）：

```json
{
  "mcpServers": {
    "codex-supervisor": {
      "command": "npx",
      "args": ["-y", "codex-supervisor-mcp"]
    }
  }
}
```

| 客户端 | macOS | Windows | Linux |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `%APPDATA%\Cursor\mcp.json` | `~/.config/cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%APPDATA%\Codeium\windsurf\mcp_config.json` | `~/.config/.codeium/windsurf/mcp_config.json` |

### npx 的坑

`npx` 不跑 `postinstall`，所以 **skill 不会自动装、MCP 也不会自动注册**，只有 MCP server 本身能起来。要用配套 skill 就还是得 `npm install -g`，或者手动跑一次 `codex-supervisor-setup`。

### 更新

```bash
npm install -g codex-supervisor-mcp@latest
npm ls -g --depth=0 | grep codex-supervisor    # 确认版本号真的变了
```

`postinstall` 会重跑一遍：skill 按内容比对，不一样就备份 `SKILL.md.bak-<时间戳>` 再覆盖；MCP 已经注册过的客户端跳过。

三个已知的坑：

- **刚发布的版本，registry 的 `latest` 会延迟几分钟**。装完发现版本号没变，就等一会儿再装，或者直接写死版本：`npm install -g codex-supervisor-mcp@0.5.3`。
- **`npm link` / `npm i -g .` 装出来的是软链**。这种情况改 `src/` 立即生效，但改 `skills/SKILL.md` 不会自动同步，要手动跑一次 `codex-supervisor-setup`。想换回正式安装，直接 `npm install -g codex-supervisor-mcp@latest` 就会覆盖掉软链。
- **换 Node 版本会让注册失效**。注册的是绝对路径（`~/.nvm/versions/node/<版本>/lib/node_modules/...`），而 `postinstall` 看到「已注册」就跳过，不会改写路径。这时先摘掉再装：

```bash
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
npm install -g codex-supervisor-mcp@latest
```

只想重跑安装、不升级版本，用 `codex-supervisor-setup`。

### 卸载

```bash
npm uninstall -g codex-supervisor-mcp
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
rm -rf ~/.claude/skills/codex-supervisor ~/.agents/skills/codex-supervisor ~/.codex/skills/codex-supervisor
rm -rf ~/.codex-supervisor      # 状态目录：sqlite、事件流、worktree 全在这
```

### Windows

- npm 装的 CLI 在 Windows 上是 `codex.cmd` 而不是可执行文件，Node 从 18.20 / 20.12 起拒绝直接 `spawn` 它（CVE-2024-27980 之后的行为，报 `EINVAL`）。这里不用 `shell: true` 绕——那样 shell 会变成子进程，取消时只杀掉 shell 而真正的 Codex 还在跑，状态机会卡在 `running`。做法是绕到 npm 包自己的入口（`node_modules/@openai/codex/bin/codex.js`），用 `node` 起它；`CODEX_BIN` 指向 `.js` 时同样处理。
- 跨进程取消用 `taskkill /PID <pid> /T /F` 结束整棵进程树；确认这个 pid 还是 Codex 用 PowerShell 的 `Get-CimInstance Win32_Process` 读命令行（拿不到时退到 `tasklist`）。`ps` 只在 macOS / Linux 上用。
- 除了 `PATH`，还会探 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`%LOCALAPPDATA%\Volta\bin`、`%ProgramFiles%\nodejs`。

自动安装只在**全局安装**时发生。`npx`、`--ignore-scripts`、以及被别人当项目依赖装的场景都不会触发。想跳过就设 `CODEX_SUPERVISOR_SKIP_SETUP=1`。

### 疑难排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `claude mcp list` 里没有 `codex-supervisor` | `npx` / `--ignore-scripts` 装法不跑 `postinstall` | 跑 `codex-supervisor-setup`，或用上面的手动挂载 |
| 派单报 `codex only resolved to a shell shim` | Windows 上只找到 `.cmd`，背后的 npm 包入口不在了 | 重装 `@openai/codex`，或把 `CODEX_BIN` 指到真正的可执行文件 / `codex.js` |
| worker 起来就 `failed`，错误是 `spawn codex ENOENT` | GUI 客户端启动的进程 `PATH` 里没有 `codex` | 在客户端配置里显式设 `CODEX_BIN` |
| `Cannot find module 'node:sqlite'` | Node < 22.13.0 | 升 Node |
| worker 卡在 `lost` | MCP 进程被 kill，worker 成了孤儿 | `list_codex_workers` 结算一次，或 `resume_codex_worker` 接回来 |
| 报 `ownedPaths overlap with active worker(s)` | 两个 worker 认领了同一片路径 | 换路径，或先 `cancel_codex_worker` 掉占用的那个 |

## 工具

14 个工具。

| 工具 | 入参 | 作用 |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `dependsOn`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | 起一个 worker |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, + 同上 | 起一个**新会话**，把老 worker 的 prompt、状态、近期事件拼进去 |
| `resume_codex_worker` | `task_id`, `prompt` | 接**同一个** Codex 会话继续跑 |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | 列出 worker，默认只看在跑的 |
| `get_orchestration_overview` | `status`, `limit` | 全部 worker 的紧凑状态表，默认给主线程用 |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `timeoutMs`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | 等终态，回摘要。默认只等 2 分钟，到点带进度快照返回，worker 照跑；接着调同一个工具继续等。默认**不带**事件（`includeEvents: false`），要事件就自己开 |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | 单个 worker 的状态：生命周期、phase、当前动作、改动文件、goal、最近的命令，prompt 默认截断。要 prompt 全文传 `includePrompt: true` |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | 读原始事件流 |
| `get_worker_goal` | `task_id` | 读 worker 的 goal（supervisor 侧 + Codex 原生） |
| `get_worker_summary` | `task_id` | 单个 worker 的一段话总结，主线程收尾时读这个 |
| `get_worker_result` | `task_id`, `limit`, `maxChars` | 读 worker 自己的完整收尾汇报。总览和 `wait_codex_workers` 把最后一条消息截到 400 字只留开头，要结论读这个 |
| `get_session_works` | `session_id` | 一个 session 派出去的全部 worker，按时间升序。主线程挂了之后靠它找回那批活 |
| `search_works` | `query`, `limit` | 在 title / goal / prompt / last_message 里做子串匹配，从新到旧 |
| `cancel_codex_worker` | `task_id` | 终止 worker，进程句柄不在本进程时按 pid 兜底 |

### 为什么 `ownedPaths` 和 `goal` 是必填

- `ownedPaths`：这个 worker 允许写的路径（相对 `cwd` 或绝对路径都行）。派单前和所有在跑的 worker 求交集，重叠就拒绝，返回冲突的 `task_id`，不会先建 worktree 再报错。
- `goal`：`{ objective, tokenBudget? }`。这是主线程做 L1 总结的锚点，也是判断 work 该不该结束的依据。

`dependsOn` 记的是 worker 之间的依赖边，落库，主线程查得到谁等谁。

### 读事件的三个闸门

`get_codex_worker_events` 的三个参数把读的成本压住：

| 参数 | 作用 |
|---|---|
| `limit` | 最多几条 |
| `maxChars` | 单条事件里超长的字符串从中间截断（保留头尾） |
| `kinds` | 只看指定的几类事件，先过滤再取 `limit` |

截断规则是照抄 Codex 自己的 `TruncationPolicy::Bytes`：中间截、保留头尾，前面加

```
Warning: truncated output (original token count: N)
Total output lines: M
```

`get_orchestration_overview` 的预算同样是硬保证：字段上限逐级收紧，直到整包 JSON 落在 7000 字节（约 1750 token）以内，返回值里的 `approx_tokens` 就是它自己的实际成本。

## work 状态机

`status` 是生命周期，一个 work 一个值，不会被进度覆盖：

| 值 | 含义 |
|---|---|
| `queued` | 已派单，未启动 |
| `running` | 运行中 |
| `completed` | 成功 |
| `failed` | 失败（非零退出码、`turn.failed`、spawn 失败） |
| `cancelled` | 被 `cancel_codex_worker` 中断 |
| `lost` | 被外部信号杀掉、或 MCP 进程消失，没写终止事件 |

`phase` 只在 `running` 时有值，到终态归 `null`：

```
starting → thinking → command → editing → reporting
```

`failed` 和 `lost` 分开是有用的：前者要看日志找原因，后者直接重跑。

Windows 上没有信号，所以这两个状态只判得出一个。libuv 杀进程走的是 `TerminateProcess(handle, 1)`，外部 kill 和进程自己 `exit(1)` 落到父进程手里完全一样（都是 `exit_code=1`、`signal=null`）。这种情况下报能证明的那个——`failed` 加退出码——而不是编一个平台根本没收到的信号名。Windows 上的 `lost` 仍然会发生，走的是 MCP 进程消失、下次启动结算孤儿那条路。

### goal 和 work 的映射

Codex 原生 goal 有六个状态，映射到 work 状态：

| goal 状态 | work status | 说明 |
|---|---|---|
| `active` | `running` | 正常推进 |
| `paused` | `running` | 暂停，等人 |
| `blocked` | `running` | 卡住，需要主线程介入 |
| `usageLimited` / `usage_limited` | `failed` | 配额用尽 |
| `budgetLimited` / `budget_limited` | `failed` | 预算用尽 |
| `complete` | `completed` | 达成 |

`paused` 和 `blocked` 不是结束，是「需要人管」。`get_orchestration_overview` 会把这两个单独列进 `needs_attention`，不用靠超时猜。

## 状态存储

默认写在 `~/.codex-supervisor/`：

| 文件 | 内容 |
|---|---|
| `data/supervisor.sqlite` | `tasks`（一行一个 work）+ `task_events`（结构化事件，带 `seq`） |
| `data/runs/<taskId>.jsonl` | Codex `--json` 原始输出，逐行事件 |
| `worktrees/<taskId>/` | 该 worker 的独立 Git worktree |

老版本（0.1.x）的库会在第一次打开时自动迁移：`editing` / `command` / `command_completed` / `reporting` 这些原本塞在 `status` 里的过程值会被拆到 `phase`，`status` 归到 `running`，一行不丢。迁移在一个 `BEGIN IMMEDIATE` 事务里做，多个进程同时启动也只会有一个真的迁移。

`changed_files` 有两个来源：Codex 的 `file_change` 事件，以及 worker 结束后读自己 worktree 的 `git status --porcelain`。后者是兜底——worker 用 shell 命令（`printf > file`）改文件时不会产生 `file_change` 事件，只有 worktree 知道真相。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | 状态根目录（sqlite / 事件流 / worktree 都在它下面） |
| `CODEX_HOME` | `~/.codex` | 只读，用来读 Codex 原生的 `goals_1.sqlite` |
| `CODEX_BIN` | `codex`（走 `PATH`） | Codex CLI 可执行文件路径。Windows 上给裸名字时会按 `PATHEXT` 展开，`.cmd` shim 会被自动绕开；指向 `.js` / `.cjs` / `.mjs` 时自动用 `node` 起它 |
| `GIT_BIN` | `git`（走 `PATH`） | Git 可执行文件路径 |

如果 MCP 客户端启动时 `PATH` 里没有 `codex`（GUI 启动的应用常见），显式设置 `CODEX_BIN`：

```json
{
  "mcpServers": {
    "codex-supervisor": {
      "command": "npx",
      "args": ["-y", "codex-supervisor-mcp"],
      "env": { "CODEX_BIN": "/usr/local/bin/codex" }
    }
  }
}
```

## 已知限制

- **worker 的生命周期绑在 MCP 进程上**：`codex` 是 MCP 进程的子进程，MCP 被 kill 时 worker 会被留下。这些 worker 会在下一次 `list_codex_workers` / `get_orchestration_overview` 时被结算成 `lost`。真正的解法是常驻 daemon，见 Roadmap。
- **worktree 从 `HEAD` 建，未提交的改动不在里面**：`ensureWorktree` 走的是 `git worktree add --detach <dir> HEAD`（`src/codex-runner.js:64`）。主线程工作区里没 commit 的修改和未跟踪文件，worker 在自己的 worktree 里看不到。要让它读写这些文件，就在 task 里给绝对路径，或者先把改动 commit。worker 的改动落在 `codex/<taskId>` 分支上，不碰主线程的工作区。
- **只隔离工作目录**：临时目录（`TMPDIR`）、数据库、端口这些进程级资源是共用的，多个 worker 同时写同一个临时文件照样互相踩。要隔开得自己在 task 里指定各自的临时目录、库名和端口。
- **`ownedPaths` 是派单前的冲突检测，不是运行时沙箱**：它只挡「两路活登记写同一个文件」，拦不住 worker 在自己 worktree 里新建清单外的文件——sandbox 是 `workspace-write`，写自己 worktree 里的任何路径都合法。校验产出还是得看 diff。
- **只管「跑完了」，不管写得对不对**：终态来自 Codex 的 `turn.completed` 和进程退出码，`exit_code: 0` 只说明它没崩。产出对不对得主线程自己核，跑校验、抽看内容。
- **长任务别指望一次 `wait_codex_workers` 等到底**：客户端给 MCP 工具调用设的超时是硬墙（`.mcp.json` 里的 `timeout`，或 `MCP_TOOL_TIMEOUT`），撞上就把这次调用掐掉。默认 2 分钟带进度返回，靠反复调而不是一次等到黑。
- **默认读回来的长文本是裁过的**：`current_action` 截到 300 字、`get_codex_worker_status` 的 prompt 截到 300 字（`includePrompt: true` 放开）、`last_message` 在总览和 wait 里截到 400 字（status 里是 4000）。全量都在库里：命令流看 `get_codex_worker_events`，结论看 `get_worker_result`。这样一条 `wait_codex_workers` 往返从几十 KB 降到几 KB——客户端把超时调用挪到后台、再把结果当通知回灌一次时，这份代价小得多。
- **不往 Codex 原生 goal 写数据**：`goals_1.sqlite` 归 Codex 所有，本 MCP 只读。worker 起来后由它自己调 Codex 的 `create_goal` 建原生 goal，本 MCP 只负责在派单时把这段指令拼进 prompt。
- **原生 goal 依赖模型照做**：`codex exec` 不会自动建 goal，是派单时那段指令让 worker 建的。模型偶尔漏调，这时 `native_goal` 为 `null`，`get_worker_goal` 退回派单时记录的那份，不影响状态机。
- **`search_works` 是子串匹配，不是全文索引**：几百条 work 的规模下 `LIKE` 扫描足够快，也省掉一套索引的维护成本。上到几万条再谈别的。
- **跨进程取消按 pid**：进程句柄不在本进程时，会先确认那个 pid 的命令行里含 `codex`（macOS / Linux 用 `ps`，Windows 用 CIM，退到 `tasklist`），再发 `SIGTERM`（Windows 上是 `taskkill /T /F`），避免误杀被复用的 pid。
- **`create_codex_followup_worker` 和 `resume_codex_worker` 不是一回事**：前者开新会话、靠文本重述上下文；后者接同一个会话。要细节不丢就用后者。
- **`session_id` 由派单方自己传，本 MCP 不生成**：一批活传同一个值，`get_session_works` 才能把它们归到一起。不传就是 `NULL`，事后按 session 找不回来。

## Roadmap

1. ~~去个人化：`CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN` 环境变量~~ ✅
2. ~~work 状态机：`status` 和 `phase` 拆开，新增 `lost`~~ ✅
3. ~~工具面：`ownedPaths` / `goal` / `dependsOn`，新增 4 个工具，事件闸门~~ ✅
4. ~~跨会话续接：`thread_id` 落库 + `resume_codex_worker`~~ ✅
5. ~~并发稳定性：两个崩溃点、所有权冲突、多进程写库~~ ✅
6. ~~session 维度：`session_id` 落库 + `get_session_works` 断线重连~~
7. ~~按关键词找历史 work：`search_works`~~
8. ~~worker 原生 goal：派单时注入 `create_goal` 指令~~
9. ~~Windows 支持：`.cmd` shim 绕行、`taskkill` 进程树、跨平台 PATH / `PATHEXT`~~ ✅
10. 常驻 daemon：派单和进程生命周期从 MCP 进程里拿出来
11. React 实时看板

砍掉不做的（说明理由，免得以后又想起来）：

| 想法 | 为什么不必要 |
|---|---|
| 向量检索 | `search_works` 的子串匹配在几百条规模下更快、零维护。两家的官方记忆系统（Codex `memories`、Claude auto-memory）也都是文件检索，不是向量 |
| `usage_count` 排序 | 实测 80 个 work 里只有 2 个被回头引用过，计数器全是 0/1，排序等于没排 |
| 复用 Codex 的 `usage_count` | 那个数统计的是"这篇记忆被引用了几次"，跟"主线程查了几次"不是一回事 |
| 三层记忆索引 | 现在的数据量撑不起一层索引，`get_worker_summary` 已经够了 |

## 配合 skill 用

仓库里带了 `skills/codex-supervisor/SKILL.md`，装完之后可以放到主线程的 skill 目录，让它自己知道什么时候该派单：

```bash
# Claude Code
mkdir -p ~/.claude/skills/codex-supervisor
cp "$(npm root -g)/codex-supervisor-mcp/skills/codex-supervisor/SKILL.md" ~/.claude/skills/codex-supervisor/

# Codex / 其他读取 ~/.agents/skills 的客户端
mkdir -p ~/.agents/skills/codex-supervisor
cp "$(npm root -g)/codex-supervisor-mcp/skills/codex-supervisor/SKILL.md" ~/.agents/skills/codex-supervisor/
```

skill 里写了派单流程、读结果该按什么顺序、`failed` 和 `lost` 怎么区分、断线怎么接。

## 开发

```bash
npm install
npm test               # 确定性测试：截断、状态机、v1→v2 迁移、setup、Windows 路由、17 项端到端回归
npm run test:real      # 用真 codex CLI 跑端到端（含跨进程 resume、worktree 隔离）
npm run smoke          # 基础冒烟（真 codex）
npm run smoke:mcp      # MCP 协议冒烟
npm run monitor        # Ink 终端看板
```

`npm test` 用 `src/test-fixtures/fake-codex.js` 回放固定的 Codex 事件流，跑得快且确定。`npm run test:real` 会真的调 `codex exec`，慢一些，但它才是「跟最新 Codex 兼容」的证据。

CI 跑 Ubuntu / macOS / Windows 三个平台，另外单独跑一个 Node 22.13.0 的 job 卡住 `engines` 声明的下界（`node:sqlite` 在它之前没有无 flag 的构建）。Windows 那 4 项 `setup-windows-test.js` 用真实文件系统模拟 `%APPDATA%\npm` 下的 `.cmd` shim，验证自动注册 MCP 这条路真的走得通，而不只是「解析函数单测过了」。

## License

MIT
