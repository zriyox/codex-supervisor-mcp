# codex-supervisor-mcp

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

让一个主线程（Claude Code、Codex，或任何 MCP 客户端）同时指挥多个 Codex worker 干活。一个 worker 一个 Git worktree，状态全部落盘，附一个网页看板盯进度。

![演示：一个 Claude Code 主线程同时派 3 个 Codex worker，各自独立 worktree，并行跑完后合并提交](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 秒演示（真跑）：主线程 `create_codex_worker` ×3，三个 worker 在各自 worktree 里并行干活，主线程收 3 份 diff 合成一次 commit。*

## 它是什么

直接让几个 agent 同时改一个仓库，结果是互相覆盖，没人说得清谁改了什么。这个 MCP 把「派单」和「记账」从模型上下文里拿出来，放到磁盘上：

| 问题 | 做法 |
|---|---|
| 几个 worker 互相踩文件 | 一个 worker 一个 Git worktree，`ownedPaths` 在派单前查冲突 |
| worker 的过程塞爆主线程上下文 | 事件写 `data/runs/<taskId>.jsonl`，读的时候有 `limit` / `maxChars` / `kinds` 三道闸 |
| 主线程读一次状态就顶满 | `get_orchestration_overview` 把全部 worker 压进 7000 字节 |
| 进程重启后不知道谁还在跑 | `supervisor.sqlite` 一行一个 work，带 `thread_id` |
| 换个会话接不上之前的 worker | `resume_codex_worker` 走 `codex exec resume <thread_id>`，接的是同一个 Codex 会话 |
| 分不清「跑失败」和「进程没了」 | 状态机把 `failed` 和 `lost` 分开 |
| 看不见一批活现在到哪了 | `codex-supervisor-web` 开一个看板，按 session 看每路 worker 在干什么 |

worker 跑的是 `codex exec`，`model` 参数原样透传。主线程留在 Claude 上做判断，worker 可以挂 DeepSeek 或任何 Codex 配了 provider 的模型，账单分开算。

## 五分钟跑起来

前置：Node.js 22.13.0 以上，`codex` CLI 在 `PATH` 里。macOS、Linux、Windows 都行。

### 1. 装

```bash
npm install -g codex-supervisor-mcp
```

全局安装的 `postinstall` 会自动做两件事：把配套 skill 装进 `~/.claude/skills/`、`~/.agents/skills/`、`~/.codex/skills/`；用 `claude mcp add -s user` 和 `codex mcp add` 把 MCP 注册上。确认一下：

```bash
claude mcp list | grep codex-supervisor
codex mcp list  | grep codex-supervisor
```

没看到就手动补（`npx`、`--ignore-scripts`、pnpm 这些装法不跑 `postinstall`）：

```bash
claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

重启 Claude Code / Codex，MCP 进程才会换成新装的。

### 2. 派第一批活

在 Claude Code 里直接说人话，skill 会让它走正确的流程：

> 把这三个模块的单测补齐，用 codex-supervisor 分三路并行跑，session 叫「补单测」。

主线程背后做的事是这样（你也可以自己调工具）：

```
create_codex_worker ×3   每路带 session_id、session_title、ownedPaths、goal
wait_codex_workers       默认等 2 分钟，到点返回快照，没完就接着等
get_worker_result ×3     收每路的完整汇报和改动清单
```

每路的改动在各自的 `codex/<taskId>` 分支上，合不合、怎么合由主线程定。

### 3. 开看板

```bash
codex-supervisor-web
# 没全局装也能起：
npx -p codex-supervisor-mcp codex-supervisor-web
```

打开 `http://127.0.0.1:7877`。左栏按 session 列，显示派单时写的标题和还有几路在跑；点进去是这个 session 的 worker 台账；再点一路，右边抽屉是它的完整汇报、改动清单、命令、事件流、任务书和 token 消耗。有 worker 在跑时 2.5 秒刷一次，静止时 8 秒。

它读哪个状态目录：环境里有 `SUPERVISOR_HOME` 就用它；没有就从当前目录往上找 `.mcp.json`，里面 `codex-supervisor` 配了 `SUPERVISOR_HOME` 就用那个；都没有才用默认的 `~/.codex-supervisor`。启动时会打印用的是哪个、从哪来的。在项目目录里敲一下就对上了，不用再传路径。

端口用 `SUPERVISOR_WEB_PORT` 改。端口被占（多半是已经有一个看板在跑）会直接说明并退出。看板不派单也不取消；「旁问」会起一个只读的 Codex 旁路会话，见下面。

## 看板里有什么

| 位置 | 内容 |
|---|---|
| 左栏 | 每个 session 一行：标题（派单时的 `session_title`，没写就用各路 goal 拼一句）、worker 数、几路在跑、最近活动时间。左下角是当前版本和更新提示 |
| session 页 | 标题、说明、首次派单和最近活动时间；一行统计（总数 / 运行中 / 完成 / 失败 / 丢失）；有 worker 在跑时列出每路正在执行的命令，静止时给最近一条汇报 |
| worker 台账 | 一行一路：状态、标题、正在跑的命令或最后一句汇报、耗时、改了几个文件（按 worktree 真实 diff 算，含已 commit 的）、跑了几条命令、更新时间。鼠标停在标题上弹出 goal 全文、负责的路径、分支 |
| worker 抽屉 | 顶上是状态、标题、goal、正在跑的命令和一行关键数字（耗时 / 文件 / 命令 / token / 退出码）；下面七个 tab：概览（开始结束、模型、沙箱、thread、分支、基线、worktree、负责的路径）、汇报（markdown 渲染）、改动、命令、事件（虚拟滚动）、任务书、旁问。抽屉和中间那条分隔线可以拖，双击还原 |
| 旁问 | 对这路 worker 提问，就是 Codex 自己的 `/btw`：从它的 Codex 线程 `fork` 出一个只读旁路会话来答，能读它的 worktree 和磁盘上任何文件，改不了东西，也不碰它正在跑的活。第一问 fork，后面几问 `resume` 同一个旁路会话，可以多轮；思考、跑的命令（带退出码和输出）、答案按步骤实时出现。每一轮的问题和输出落在 sqlite 的 `side_turns` 表里：切 tab、关抽屉、刷新页面都不会断，回来自动接上回放；另一个标签页也能接上看或者停掉它；没人看的一轮照样跑完，结果留着；看板重启时正在跑的一轮标成「中断」。「结束并清空」会 `codex delete` 掉旁路会话并清掉记录。0.5 之前派的 worker 没记 thread id，问不了 |

浅色深色跟系统走。只用系统字体，没有外网资源。

## 工具

16 个。

| 工具 | 入参 | 作用 |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | 起一个 worker。`session_title` / `session_note` 记这批活是干什么的；`baseRef` 指定 worktree 从哪个提交切，默认仓库 `HEAD`，要接着另一路没合进主线的 `codex/<id>` 分支干就填它 |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, 其余同上 | 开一个新会话，把老 worker 的 prompt、状态、近期事件拼进去 |
| `resume_codex_worker` | `task_id`, `prompt` | 接同一个 Codex 会话继续跑，`thread_id` 不变 |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `timeoutMs`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | 等终态。默认 2 分钟，到点带快照返回，worker 照跑；`still_running: true` 时拿同一批 id 接着调。默认不带事件 |
| `get_orchestration_overview` | `status`, `limit` | 全部 worker 的状态表，封顶 7000 字节。带 `version` 和 `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars` | worker 自己的完整汇报，外加 `status` / `exit_code` / `changed_files`。收结论用这个 |
| `get_worker_summary` | `task_id` | 一段话：goal、状态、改动、最后一条命令和消息 |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | 单个 worker 的状态细节，prompt 默认截到 300 字 |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | 原始事件流 |
| `get_worker_goal` | `task_id` | 派单时记的 goal + Codex 原生 goal（token、用时） |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | 列 worker，默认只看在跑的 |
| `get_session_works` | `session_id` | 一个 session 的全部 worker 和它的标题、说明。主线程重启后靠它找回那批活 |
| `describe_session` | `session_id`, `title`, `note` | 给 session 记标题和说明，没传的字段保留 |
| `search_works` | `query`, `limit` | 在 title / goal / prompt / last_message 里找子串，从新到旧 |
| `check_for_update` | `force` | 问 registry 有没有新版本、本机文件和发布的 tarball 是否一致 |
| `cancel_codex_worker` | `task_id` | 终止 worker。进程句柄不在本进程时按 pid 兜底，先确认那个 pid 跑的是 codex |

### 三个必填项

- `ownedPaths`：这路 worker 允许写的路径。派单前和所有在跑的 worker 求交集，重叠就拒，返回冲突的 `task_id`，worktree 都不会建。它只在派单时查，不是运行时沙箱。
- `goal.objective`：一句话说这路活的目标。worker 起手会用它建 Codex 原生 goal，干完标 complete。
- `session_id`：严格说不是必填，但不传就归不了组，看板和 `get_session_works` 都找不回来。一批活传同一个值，第一路顺手带上 `session_title`。

### 读结果别撑爆上下文

| 想干什么 | 用哪个 | 代价 |
|---|---|---|
| 看全部 worker 状态 | `get_orchestration_overview` | 7000 字节封顶 |
| 收一路的结论 | `get_worker_result` | 汇报全文，大活上万字 |
| 只看活着还是完了 | `get_worker_summary` | 一段话 |
| 看过程 | `get_codex_worker_events` | 用 `kinds` 先滤、`limit` 限条数、`maxChars` 截长串 |

派单回执是精简的，不回传任务原文。`wait_codex_workers` 的 `last_message` 截到 400 字，`current_action` 截到 300 字，要全文走 `get_worker_result` 和 `get_codex_worker_events`。这些裁剪是为了一次 wait 五路从几十 KB 降到几 KB；客户端把超时的调用挪到后台再把结果当通知回灌时，这个差别很大。

## 和 Claude Code 的 subagent 有什么区别

文件隔离不是差别：subagent 自己也能开 worktree（`isolation: worktree`）。差别在模型和进程。

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| 能跑什么模型 | 只能选 Claude | `model` 透传给 Codex CLI，DeepSeek 也能挂 |
| 干活的是谁 | Claude Code 自己 | 独立的 `codex exec` 进程 |
| 两路写同一个文件 | 靠 worktree 隔开，没有路径声明 | 派单前查 `ownedPaths` 交集，重叠直接拒 |
| 主线程进程挂了 | worker 一起没 | `thread_id` 在 sqlite 里，`resume_codex_worker` 接回同一个会话 |
| 谁能驱动 | 只有 Claude Code | 任何 MCP 客户端 |
| 看过程 | 只有它返回的结论 | 原始 JSONL 和网页看板 |

## 状态机

`status` 是生命周期，一个 work 一个值：

| 值 | 含义 |
|---|---|
| `queued` | 已派单，未启动 |
| `running` | 运行中 |
| `completed` | 成功 |
| `failed` | 非零退出码、`turn.failed`、spawn 失败 |
| `cancelled` | 被 `cancel_codex_worker` 中断 |
| `lost` | 被外部信号杀掉、MCP 进程消失、或者行写了但进程从没起来 |

`phase` 只在 `running` 时有值：`starting → thinking → command → editing → reporting`。

`failed` 要看日志，`lost` 直接重跑。终态分两步落盘：`turn.completed` 先把 status 置成 completed，进程退出后才写 `exit_code`；`wait_codex_workers` 等到 `exit_code` 落了才返回，直接读 status 撞上 `completed` 配 `exit_code: null` 就过一会再读。

Windows 没有信号，外部 kill 和进程自己 `exit(1)` 在父进程看来一样，所以那里只报 `failed` 加退出码。

Codex 原生 goal 的六个状态映射：`active` / `paused` / `blocked` 都算 `running`（后两个进 `needs_attention`），`usageLimited` / `budgetLimited` 算 `failed`，`complete` 算 `completed`。

## 状态存储

默认在 `~/.codex-supervisor/`：

| 文件 | 内容 |
|---|---|
| `data/supervisor.sqlite` | `tasks`（一行一个 work）、`task_events`（结构化事件）、`sessions`（标题和说明） |
| `data/runs/<taskId>.jsonl` | Codex `--json` 的原始输出 |
| `data/update-check.json` | 更新检查的缓存 |
| `worktrees/<taskId>/` | 该 worker 的 Git worktree |

`changed_files` 有三个来源：Codex 的 `file_change` 事件；worktree 里的 `git status --porcelain`（未提交的）；`git diff --name-only <base_commit> HEAD`（已提交的）。后两个是兜底。worker 用 shell 改文件不产生 `file_change` 事件，自己 commit 之后 `git status` 又是干净的，一批五路 worker 全这么干过，读回来全是空数组。`base_commit` 派单时记在行上，更早的行退回去读分支 reflog 最老那条。git 读操作都带 `core.quotePath=false`，中文文件名不会变成八进制转义。

老版本（0.1.x）的库第一次打开时自动迁移，一行不丢。

## 更新检查

MCP 启动时问一次 npm registry：`latest` 是哪个版本，tarball integrity 是多少。和本机比两样：

- 版本号。比 `latest` 低，`get_orchestration_overview`、派单回执、`wait_codex_workers` 的返回里多一个 `update` 字段，带 `latest_version` 和 `npm i -g codex-supervisor-mcp@latest`。skill 让主线程看到就转告你。
- 文件。全局安装时 npm 把解出来的 integrity 记在 `node_modules/.package-lock.json`，和 registry 上这个版本的不一样就说明本机文件不是发布的那份，同样提示重装。git checkout 没这个值，只记 commit。

缓存一小时，跑着的时候每六小时再查。registry 连不上不报错，结果标 `source: "offline"`。看板左下角显示同一个结果。`CODEX_SUPERVISOR_NO_UPDATE_CHECK=1` 关掉，`CODEX_SUPERVISOR_REGISTRY` 指到私有源。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | 状态根目录。MCP 和看板要指同一个 |
| `CODEX_HOME` | `~/.codex` | 只读，读 Codex 原生的 `goals_1.sqlite` |
| `CODEX_BIN` | `codex` | Codex CLI 路径。Windows 上 `.cmd` shim 自动绕开，指向 `.js` 时用 `node` 起 |
| `GIT_BIN` | `git` | Git 路径 |
| `SUPERVISOR_WEB_PORT` / `SUPERVISOR_WEB_HOST` | `7877` / `127.0.0.1` | 看板监听地址 |
| `CODEX_SUPERVISOR_NO_UPDATE_CHECK` | 未设 | `1` 关闭更新检查 |
| `CODEX_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | 更新检查用的 registry |
| `CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | 等 registry 的上限 |
| `CODEX_SUPERVISOR_SKIP_SETUP` | 未设 | `1` 跳过 `postinstall` 的自动安装 |

GUI 客户端起的进程 `PATH` 里常常没有 `codex`，在配置里显式给 `CODEX_BIN`：

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

## 安装细节

### GUI 客户端

GUI 不跑 `postinstall`，自己把上面那段 JSON 加进配置文件：

| 客户端 | macOS | Windows | Linux |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `%APPDATA%\Cursor\mcp.json` | `~/.config/cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%APPDATA%\Codeium\windsurf\mcp_config.json` | `~/.config/.codeium/windsurf/mcp_config.json` |

### 重跑安装

```bash
codex-supervisor-setup                      # 自动检测客户端，补 skill + 注册 MCP
codex-supervisor-setup --target claude,codex
codex-supervisor-setup --skill-only
codex-supervisor-setup --mcp-only
codex-supervisor-setup --dry-run            # 只打印计划
```

skill 已存在且内容不同时先备份成 `SKILL.md.bak-<时间戳>` 再覆盖。

### 更新

```bash
npm install -g codex-supervisor-mcp@latest
npm ls -g --depth=0 | grep codex-supervisor
```

然后重启 Claude Code / Codex。三个坑：

- 刚发布的版本 registry 要几分钟才切 `latest`，装完版本没变就等一会，或者写死版本号。
- `npm link` 装出来的是软链，改 `src/` 立即生效，但 skill 不会自动同步，手动跑 `codex-supervisor-setup`。
- 换了 Node 版本，注册的绝对路径就失效了。先 `claude mcp remove -s user codex-supervisor` 和 `codex mcp remove codex-supervisor`，再装。

### 卸载

```bash
npm uninstall -g codex-supervisor-mcp
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
rm -rf ~/.claude/skills/codex-supervisor ~/.agents/skills/codex-supervisor ~/.codex/skills/codex-supervisor
rm -rf ~/.codex-supervisor
```

### Windows

- npm 装的 CLI 是 `codex.cmd`，Node 从 18.20 / 20.12 起拒绝直接 spawn 它（CVE-2024-27980 之后的行为）。这里不用 `shell: true` 绕，那样取消时只杀得掉 shell。做法是绕到 `node_modules/@openai/codex/bin/codex.js`，用 `node` 起。
- 跨进程取消用 `taskkill /PID <pid> /T /F` 杀整棵树，先用 `Get-CimInstance Win32_Process` 确认那个 pid 跑的是 codex。
- 除 `PATH` 外还探 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`%LOCALAPPDATA%\Volta\bin`、`%ProgramFiles%\nodejs`。

### 排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `claude mcp list` 里没有 | 装法不跑 `postinstall` | `codex-supervisor-setup` 或手动 `claude mcp add` |
| 派单报 `codex only resolved to a shell shim` | Windows 只找到 `.cmd`，背后的包入口没了 | 重装 `@openai/codex`，或 `CODEX_BIN` 指到 `codex.js` |
| worker 一起来就 `failed`，`spawn codex ENOENT` | 进程 `PATH` 里没有 codex | 配置里设 `CODEX_BIN` |
| `Cannot find module 'node:sqlite'` | Node 低于 22.13.0 | 升 Node |
| worker 卡在 `lost` | MCP 进程被杀，worker 成孤儿 | `resume_codex_worker` 接回，或重派 |
| `ownedPaths overlap with active worker(s)` | 两路认领了同一片路径 | 改拆法，或先取消占着的那路 |
| 看板打开是空的 | 看板和 MCP 的 `SUPERVISOR_HOME` 不是同一个 | 在配了 `.mcp.json` 的项目目录里起，或者显式传同一个 `SUPERVISOR_HOME`；启动日志第二行写了它用的哪个 |
| `port 7877 ... is already in use` | 已经有一个看板在跑 | 直接开 `http://127.0.0.1:7877`，或 `SUPERVISOR_WEB_PORT=8080` 再起一个 |

## 已知限制

- worker 的命绑在 MCP 进程上。MCP 被 kill，worker 留在那，下次读状态结算成 `lost`。解法是常驻 daemon，在 Roadmap 里。
- worktree 从一个提交切，你工作区里没 commit 的东西不在里面。要让 worker 读到，给绝对路径或先 commit。
- 只隔离工作目录。临时目录、数据库、端口是共用的，多路 worker 要连同一个 dev server 得自己错开。
- `ownedPaths` 只在派单时查，拦不住 worker 在自己 worktree 里新建清单外的文件。收活看 diff。
- 只管「跑完了」不管「对不对」。`exit_code: 0` 只说明没崩，验收得主线程自己做。
- 一次 `wait_codex_workers` 别指望等到底。客户端的 MCP 工具超时是硬墙，默认 2 分钟返回快照，靠反复调。
- 不往 Codex 原生 goal 写数据，`goals_1.sqlite` 只读。原生 goal 是 worker 自己建的，模型偶尔漏调，这时 `native_goal` 为 `null`，不影响状态机。
- `search_works` 是子串匹配，几百条够用，几万条再说。

## Roadmap

1. ~~`CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN`~~ ✅
2. ~~`status` 和 `phase` 拆开，新增 `lost`~~ ✅
3. ~~`ownedPaths` / `goal` / `dependsOn`，事件闸门~~ ✅
4. ~~`thread_id` 落库 + `resume_codex_worker`~~ ✅
5. ~~并发：崩溃点、所有权冲突、多进程写库~~ ✅
6. ~~`session_id` + `get_session_works`~~ ✅
7. ~~`search_works`~~ ✅
8. ~~worker 原生 goal~~ ✅
9. ~~Windows~~ ✅
10. ~~网页看板~~ ✅
11. ~~session 标题、更新检查、`baseRef`、已 commit 的改动可见~~ ✅
12. 常驻 daemon：派单和进程生命周期从 MCP 进程里拿出来

不做的：向量检索（子串匹配在这个规模更快、零维护）、`usage_count` 排序（实测 80 个 work 里只有 2 个被回头引用过）、三层记忆索引（数据量撑不起）。

## 开发

```bash
npm install
npm test               # 截断、状态机、迁移、setup、Windows 路由、23 项回归、40 项边界
npm run test:edge      # 只跑 test/edge：假 registry 的更新检查、session 标题、baseRef、中文路径、僵尸行、看板 API
npm run test:real      # 真 codex CLI 端到端
npm run smoke:mcp      # MCP 协议冒烟
npm run monitor        # Ink 终端看板
npm run web:install    # 看板依赖
npm run web:dev        # 看板开发，/api 代理到 7877
npm run web:build      # 打包到 web/dist，发 npm 前自动跑
```

`npm test` 用 `src/test-fixtures/fake-codex.js` 回放固定事件流，快且确定；`npm run test:real` 才是「跟最新 Codex 兼容」的证据。CI 跑 Ubuntu / macOS / Windows，另加一个 Node 22.13.0 的 job 卡 `engines` 下界。

## License

MIT
