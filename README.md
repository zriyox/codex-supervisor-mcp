# codex-supervisor-mcp

让一个主线程（Claude Code、Codex、任何 MCP 客户端）同时指挥多个 Codex worker 干活。

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

需要 Node.js >= 22 和 `codex` CLI 在 `PATH` 里。macOS、Linux、Windows 都支持。

```bash
npm install -g codex-supervisor-mcp
```

全局安装会自动完成两件事（`postinstall`）：

1. 把配套 skill 装进检测到的客户端目录：`~/.claude/skills/`、`~/.agents/skills/`、`~/.codex/skills/`。
2. 用客户端自带的 CLI 注册 MCP：`claude mcp add -s user` / `codex mcp add`。

目标 skill 已存在且内容不同时，先写一份 `SKILL.md.bak-<时间戳>` 再覆盖。任何一步失败都不会让安装失败。

重跑、修复、或只装某一个客户端：

```bash
codex-supervisor-setup                      # 自动检测客户端
codex-supervisor-setup --target claude,codex
codex-supervisor-setup --skill-only         # 只装 skill
codex-supervisor-setup --dry-run            # 只打印计划
```

### Windows

支持 Windows，两条实现细节值得知道：

- npm 装的 CLI 在 Windows 上是 `codex.cmd` 而不是可执行文件，Node 从 18.20 / 20.12 起拒绝直接 `spawn` 它（CVE-2024-27980 之后的行为，报 `EINVAL`）。这里不用 `shell: true` 绕——那样 shell 会变成子进程，取消时只杀掉 shell 而真正的 Codex 还在跑，状态机会卡在 `running`。做法是绕到 npm 包自己的入口（`node_modules/@openai/codex/bin/codex.js`），用 `node` 起它。
- 跨进程取消用 `taskkill /PID <pid> /T /F` 结束整棵进程树；确认这个 pid 还是 Codex 用 PowerShell 的 `Get-CimInstance Win32_Process` 读命令行（拿不到时退到 `tasklist`）。`ps` 只在 macOS / Linux 上用。

除了 `PATH`，还会探 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`%LOCALAPPDATA%\Volta\bin`、`%ProgramFiles%\nodejs`。

自动安装只在**全局安装**时发生。`npx`、`--ignore-scripts`、以及被别人当项目依赖装的场景都不会触发。要跳过用 `CODEX_SUPERVISOR_SKIP_SETUP=1`；要补装手动跑一次 `codex-supervisor-setup`。

### 手动配置到 Claude Code

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

### 配置到 Codex

```bash
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

## 工具

13 个工具。

| 工具 | 入参 | 作用 |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `dependsOn`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | 起一个 worker |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, + 同上 | 起一个**新会话**，把老 worker 的 prompt、状态、近期事件拼进去 |
| `resume_codex_worker` | `task_id`, `prompt` | 接**同一个** Codex 会话继续跑 |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | 列出 worker，默认只看在跑的 |
| `get_orchestration_overview` | `status`, `limit` | 全部 worker 的紧凑状态表，默认给主线程用 |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | 阻塞等到终态，回摘要 |
| `get_codex_worker_status` | `task_id` | 单个 worker 的完整记录 |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | 读原始事件流 |
| `get_worker_goal` | `task_id` | 读 worker 的 goal（supervisor 侧 + Codex 原生） |
| `get_worker_summary` | `task_id` | 单个 worker 的一段话总结，主线程收尾时读这个 |
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
| `CODEX_BIN` | `codex`（走 `PATH`） | Codex CLI 可执行文件路径。Windows 上给裸名字时会按 `PATHEXT` 展开，`.cmd` shim 会被自动绕开 |
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
npm test               # 确定性测试：截断移植、状态机、v1→v2 迁移、setup、Windows 解析器、17 项端到端回归
npm run test:real      # 用真 codex CLI 跑端到端（含跨进程 resume、worktree 隔离）
npm run smoke          # 基础冒烟（真 codex）
npm run smoke:mcp      # MCP 协议冒烟
npm run monitor        # Ink 终端看板
```

`npm test` 用 `src/test-fixtures/fake-codex.js` 回放固定的 Codex 事件流，跑得快且确定。`npm run test:real` 会真的调 `codex exec`，慢一些，但它才是「跟最新 Codex 兼容」的证据。

## License

MIT
