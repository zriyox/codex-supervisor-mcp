# codex-supervisor-mcp

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

让几个 agent 同时改一个仓库，结果是互相覆盖、没人说得清谁改了什么，主线程的上下文还被 worker 的输出塞满。

**codex-supervisor-mcp** 是一个 Codex MCP server，把「派单」和「记账」从模型上下文里拿出来放到磁盘上：一个主线程（Claude Code、Codex 或任何 MCP 客户端）同时指挥多个 Codex CLI worker，一个 worker 一个 Git worktree，状态落盘到 SQLite，附一个网页看板。

![演示：一个 Claude Code 主线程同时派 3 个 Codex worker，各自独立 worktree，并行跑完后合并提交](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 秒真跑：`create_codex_worker` ×3，三个 worker 各自 worktree 并行，主线程收 3 份 diff 合成一次 commit。*

## 解决什么

| 问题 | 做法 |
|---|---|
| 几个 worker 互相踩文件 | 一个 worker 一个 Git worktree，`ownedPaths` 在派单前查冲突 |
| worker 的过程塞爆主线程上下文 | 事件写 `data/runs/<taskId>.jsonl`，读的时候有 `limit` / `maxChars` / `kinds` 三道闸 |
| 主线程读一次状态就顶满 | `get_orchestration_overview` 把全部 worker 压进 7000 字节 |
| 进程重启后不知道谁还在跑 | `supervisor.sqlite` 一行一个 work，带 `thread_id` |
| 换个会话接不上之前的 worker | `resume_codex_worker` 走 `codex exec resume <thread_id>`，接的是同一个 Codex 会话 |
| 分不清「跑失败」和「进程没了」 | 状态机把 `failed` 和 `lost` 分开 |
| 看不见一批活现在到哪了 | `codex-supervisor-web` 开一个看板，按 session 看每路 worker 在干什么 |

worker 跑的是 `codex exec`，`model` 透传：主线程留在 Claude，worker 可以挂 DeepSeek 或任何 Codex 配了 provider 的模型，账单分开算。

## 五分钟跑起来

前置：Node.js 22.13.0 以上，`codex` CLI 在 `PATH` 里。macOS、Linux、Windows 都行。

### 1. 装

```bash
npm install -g codex-supervisor-mcp
```

`postinstall` 装 skill、注册 MCP。`claude mcp list` 里没看到（`npx`、pnpm、`--ignore-scripts` 不跑 `postinstall`）就手动补：

```bash
claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

重启 Claude Code / Codex。以后不用再手动更，见「更新」。

### 2. 派第一批活

在 Claude Code 里直接说人话，skill 会让它走正确的流程：

> 把这三个模块的单测补齐，用 codex-supervisor 分三路并行跑，session 叫「补单测」。

主线程背后做的事（你也可以自己调工具）：

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

打开 `http://127.0.0.1:7877`。状态目录按 `SUPERVISOR_HOME`、最近的 `.mcp.json`、`~/.codex-supervisor` 的顺序找；端口用 `SUPERVISOR_WEB_PORT` 改。看板只看，不派单不取消。

## 我自己怎么用

能连 MCP 的都能当主线程，这里只是我的用法。我开两个 Claude Code 会话，一个只管文档，一个只管派活：一个会话又写详设又盯 worker，上下文两小时就满。

| 谁 | 开在哪 | 管什么 |
|---|---|---|
| 我 | | 定需求，拍板，看汇报 |
| 规划会话 | 需求和文档仓 | 聊需求，写详设，每一块活写一份任务书，末尾附一段发给主脑的话 |
| 主脑会话 | 代码仓的一个 worktree | 读任务书，派 Codex worker，核每路的 diff，把结果填回任务书，向我汇报。不写业务代码 |
| Codex worker | 各自的 worktree | 一个 worker 做一步，一个提交，在远端机器上编译和验证。不 push，不合并 |

两个会话之间只传一段文字，粘进主脑会话用 `/goal` 接上。结构固定：

```text
【角色】   你是主脑：读文档和代码，派 worker，核结果，更新文档，向我汇报。不写业务代码。
           派活和盯进度用 codex-supervisor 这个 skill，开工前先加载它。
【背景】   这一块为什么做，上一块留下了什么
【先读】   哪几份文档的哪几节。几份说法不一样时以哪份为准
【仓和分支】工作目录在哪，各分支现在在哪个提交，哪些分支只读
【做什么】 照任务书第几节那张表做。一步一个提交，这步验证过了才做下一步。表里没有的不做
【派活】   先 search_works 看有没有派过，别重复
           整批用同一个 session_id
           改同一批文件就串行，文件完全不重叠才并行，每路 ownedPaths 写清
           一个 worker 只做一步。task 写全：背景、文档出处、要改的文件、验证命令、输出格式
           worker 交回来先看 diff。它说过了不算，你看到才算
【构建和测试】全走远端机器，本机不跑
【红线】   不改什么，不推什么，不读什么
【必须停下来问我】
【汇报】   中文，表格优先，报哪几项，然后停下来等我
```

主脑一轮下来调的工具：

```
search_works            查这批活派过没有
create_codex_worker     一步一个 worker，同一个 session_id，ownedPaths 不重叠
wait_codex_workers      2 分钟一轮，compact: true，没完接着调
get_worker_result       它说自己做了什么
get_worker_diff         它实际做了什么
ask_codex_worker        对不上就问它为什么，只读，不动它的线程
resume_codex_worker     要改就追一条，让它 amend 进原来那个提交
land_codex_worker       核过了，落进集成分支
```

上一块活 25 步，主脑会话从头跑到尾，上下文里只有任务书和每路的汇报。一个 worker 只做一步是试出来的：某一步不对，`resume_codex_worker` 追一条让它 `--amend` 进原来那个提交，再核一次才落；一个 worker 做三步，第 5 步错了，第 6、7 步已经叠在上面，没法这么修。

## 看板里有什么

| 位置 | 内容 |
|---|---|
| 左栏 | 每个 session 一行：标题、worker 数、几路在跑、最近活动。左下角是版本和更新提示 |
| session 页 | 统计（总数 / 运行中 / 完成 / 失败 / 丢失），有 worker 在跑时列每路正在执行的命令 |
| worker 台账 | 一行一路：状态、标题、正在跑的命令或最后一句汇报、耗时、改了几个文件、跑了几条命令 |
| worker 抽屉 | 七个 tab：概览、汇报、改动、命令、事件、任务书、旁问 |
| 旁问 | 对这路 worker 提问，就是 Codex 的 `/btw`：从它的线程 fork 出只读旁路会话来答，不碰它正在跑的活。多轮、可中断、换标签页回来自动接上 |

浅色深色跟系统走，没有外网资源。

## 工具

19 个。

| 工具 | 入参 | 作用 |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | 起一个 worker。`baseRef` 指定 worktree 从哪个提交切，默认 `HEAD`，接着另一路干就填它的 `codex/<id>` |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, 其余同上 | 开一个新会话，把老 worker 的 prompt、状态、近期事件拼进去 |
| `resume_codex_worker` | `task_id`, `prompt` | 接同一个 Codex 会话继续跑，`thread_id` 不变 |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `timeoutMs`, `compact`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | 等终态。默认 2 分钟，到点带快照返回，worker 照跑；`compact` 每路只回一行 |
| `get_orchestration_overview` | `status`, `limit` | 全部 worker 的状态表，封顶 7000 字节。带 `version` 和 `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars` | worker 自己的完整汇报，外加 `status` / `exit_code` / `changed_files` |
| `get_worker_diff` | `task_id`, `maxChars`, `paths` | worker 实际改了什么：从 worktree 起点到工作区的 patch，提交没提交都算。`maxChars` 管总量，超了的文件只列名 |
| `ask_codex_worker` | `task_id`, `question`, `timeoutMs`, `maxChars`, `fresh`, `end` | 旁路问 worker 一句。线程 fork 成只读侧会话，没网络、没 MCP 工具，worker 本身不动。worker 被 resume 过会自动换新 fork，`fresh` 强制换，`end` 删 |
| `land_codex_worker` | `task_id`, `onto`, `commitMessage` | 把 worker 在 `codex/<id>` 上的提交 cherry-pick 到派单目录的当前分支。目标必须干净，冲突就回滚。`commitMessage` 先替它把未提交的改动提交成一笔 |
| `get_worker_summary` | `task_id` | 一段话：goal、状态、改动、最后一条命令和消息 |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | 单个 worker 的状态细节 |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | 原始事件流 |
| `get_worker_goal` | `task_id` | 派单时记的 goal + Codex 原生 goal（token、用时） |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | 列 worker，默认只看在跑的 |
| `get_session_works` | `session_id` | 一个 session 的全部 worker。主线程重启后靠它找回那批活 |
| `describe_session` | `session_id`, `title`, `note` | 给 session 记标题和说明 |
| `search_works` | `query`, `limit` | 在 title / goal / prompt / last_message 里找子串，从新到旧 |
| `check_for_update` | `force` | 问 registry 有没有新版本 |
| `cancel_codex_worker` | `task_id` | 终止 worker。跨进程按 pid 兜底，先确认那个 pid 跑的是 codex |

必填的两个：`ownedPaths`（派单前和在跑的 worker 求交集，重叠就拒，只在派单时查）和 `goal.objective`（worker 会建成 Codex 原生 goal）。`session_id` 不传就归不了组，一批活传同一个值。

## 和 Claude Code 的 subagent 有什么区别

文件隔离不是差别：subagent 自己也能开 worktree。差别在模型和进程。

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| 能跑什么模型 | 只能选 Claude | `model` 透传给 Codex CLI，DeepSeek 也能挂 |
| 干活的是谁 | Claude Code 自己 | 独立的 `codex exec` 进程 |
| 两路写同一个文件 | 靠 worktree 隔开，没有路径声明 | 派单前查 `ownedPaths` 交集，重叠直接拒 |
| 主线程进程挂了 | worker 一起没 | `thread_id` 在 sqlite 里，`resume_codex_worker` 接回同一个会话 |
| 谁能驱动 | 只有 Claude Code | 任何 MCP 客户端 |
| 看过程 | 只有它返回的结论 | 原始 JSONL 和网页看板 |

## 状态机

| `status` | 含义 |
|---|---|
| `queued` | 已派单，未启动 |
| `running` | 运行中。`phase`：`starting → thinking → command → editing → reporting` |
| `completed` | 成功 |
| `failed` | 非零退出码、`turn.failed`、spawn 失败 |
| `cancelled` | 被 `cancel_codex_worker` 中断 |
| `lost` | 被外部信号杀掉、MCP 进程消失、或者行写了但进程从没起来。`resume_codex_worker` 接回 |

终态分两步落盘：`turn.completed` 先把 status 置成 completed，进程退出后才写 `exit_code`；`wait_codex_workers` 等到 `exit_code` 落了才返回。Windows 没有信号，外部 kill 只报 `failed` 加退出码。Codex 原生 goal 的 `paused` / `blocked` 算 `running` 并进 `needs_attention`，`usageLimited` / `budgetLimited` 算 `failed`。

## 状态存储

默认在 `~/.codex-supervisor/`：

| 文件 | 内容 |
|---|---|
| `data/supervisor.sqlite` | `tasks`（一行一个 work）、`task_events`、`sessions`、`side_sessions` / `side_turns`（旁问） |
| `data/runs/<taskId>.jsonl` | Codex `--json` 的原始输出 |
| `data/update-check.json`、`auto-update.json` | 更新检查和后台更新的记录 |
| `worktrees/<taskId>/` | 该 worker 的 Git worktree |

`changed_files` 按 worktree 的真实 diff 算，worker 用 shell 改的、自己 commit 过的都能看到。中文文件名原样返回。老版本的库第一次打开自动迁移。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | 状态根目录。MCP 和看板要指同一个 |
| `CODEX_HOME` | `~/.codex` | 只读，读 Codex 原生的 `goals_1.sqlite` 和 MCP 配置 |
| `CODEX_BIN` | `codex` | Codex CLI 路径。Windows 上 `.cmd` shim 自动绕开 |
| `GIT_BIN` | `git` | Git 路径 |
| `SUPERVISOR_WEB_PORT` / `SUPERVISOR_WEB_HOST` | `7877` / `127.0.0.1` | 看板监听地址 |
| `CODEX_SUPERVISOR_NO_UPDATE_CHECK` | 未设 | `1` 关闭更新检查 |
| `CODEX_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | 更新检查和自动更新用的 registry |
| `CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | 等 registry 的上限 |
| `CODEX_SUPERVISOR_NO_AUTO_UPDATE` | 未设 | `1` 关闭后台自动更新（只提醒） |
| `CODEX_SUPERVISOR_SKIP_SKILL_SYNC` | 未设 | `1` 关闭 server 启动时的 skill 同步 |
| `CODEX_SUPERVISOR_SKIP_SETUP` | 未设 | `1` 跳过 `postinstall` 的自动安装 |
| `CODEX_SUPERVISOR_NPM` | 未设 | 自动更新用的 npm，默认用当前 node 自带的 |

GUI 客户端（Claude Desktop、Cursor、Windsurf）不跑 `postinstall`，自己把这段加进它的 MCP 配置文件，`PATH` 里常常没有 `codex`，显式给 `CODEX_BIN`：

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

## 更新

不用手动更。server 启动时后台查一次 registry，有新版就起独立进程 `npm i -g` 到同一个全局路径；正在跑的会话不受影响，下一个新会话就是新版。只对 `npm i -g` 装的那份生效，git 源码和 `npx` 起的不碰。skill 也一样，每次启动刷到已有的 skill 目录，改过的先备份成 `SKILL.md.bak-<时间戳>`。

装失败（全局目录要 sudo）时 `update` 字段带原因，手动 `npm install -g codex-supervisor-mcp@latest`。0.6.1 及以前只提醒不自动装，手动升一次就进自动了。换了 Node 版本注册的路径会失效，`claude mcp remove -s user codex-supervisor`、`codex mcp remove codex-supervisor` 后重装。重跑安装：`codex-supervisor-setup`（`--skill-only` / `--mcp-only` / `--dry-run`）。

卸载：

```bash
npm uninstall -g codex-supervisor-mcp
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
rm -rf ~/.claude/skills/codex-supervisor ~/.agents/skills/codex-supervisor ~/.codex/skills/codex-supervisor ~/.codex-supervisor
```

## Windows

- npm 装的 CLI 是 `codex.cmd`，Node 拒绝直接 spawn 它。这里绕到 `node_modules/@openai/codex/bin/codex.js` 用 `node` 起，不用 `shell: true`，那样取消时只杀得掉 shell。
- 跨进程取消用 `taskkill /PID <pid> /T /F` 杀整棵树，先确认那个 pid 跑的是 codex。
- 除 `PATH` 外还探 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`%LOCALAPPDATA%\Volta\bin`、`%ProgramFiles%\nodejs`。

## 排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `claude mcp list` 里没有 | 装法不跑 `postinstall` | `codex-supervisor-setup` 或手动 `claude mcp add` |
| 派单报 `codex only resolved to a shell shim` | Windows 只找到 `.cmd`，背后的包入口没了 | 重装 `@openai/codex`，或 `CODEX_BIN` 指到 `codex.js` |
| worker 一起来就 `failed`，`spawn codex ENOENT` | 进程 `PATH` 里没有 codex | 配置里设 `CODEX_BIN` |
| `Cannot find module 'node:sqlite'` | Node 低于 22.13.0 | 升 Node |
| worker `lost` | MCP 进程被杀，worker 跟着没了 | `resume_codex_worker` 接回 |
| worker 说 `git add` 报 `index.lock: Operation not permitted` | 默认沙箱把 `.git` 设成只读 | 收活时 `land_codex_worker` 带 `commitMessage`，或派单用 `danger-full-access` |
| `ownedPaths overlap with active worker(s)` | 两路认领了同一片路径 | 改拆法，或先取消占着的那路 |
| 看板打开是空的 | 看板和 MCP 的 `SUPERVISOR_HOME` 不是同一个 | 在配了 `.mcp.json` 的项目目录里起，或显式传同一个 `SUPERVISOR_HOME` |
| `port 7877 ... is already in use` | 已经有一个看板在跑 | 直接开它，或 `SUPERVISOR_WEB_PORT=8080` 再起一个 |

## 已知限制

- worker 是 MCP 进程的子进程。MCP 被 kill，worker 跟着没了，结算成 `lost`；worktree 和 `thread_id` 都在，`resume_codex_worker` 接回。让它不跟着死要常驻 daemon，在 Roadmap 里。
- 默认 `workspace-write` 沙箱里 worker 提交不了（Codex 把 `.git` 设成只读）。要么收活时 `land_codex_worker` 带 `commitMessage` 替它提交，要么派单用 `danger-full-access`。
- worktree 从一个提交切，你工作区里没 commit 的东西不在里面。
- 只隔离工作目录。临时目录、数据库、端口是共用的。
- `ownedPaths` 只在派单时查，拦不住 worker 新建清单外的文件。收活看 diff。
- 只管「跑完了」不管「对不对」，验收得主线程自己做。
- 一次 `wait_codex_workers` 等不到底，客户端的 MCP 工具超时是硬墙，靠反复调。
- `search_works` 是子串匹配，几百条够用。

## Roadmap

做完的：`CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN`；`status` 和 `phase` 拆开；`ownedPaths` / `goal` / `dependsOn`；`thread_id` 落库 + `resume_codex_worker`；并发和多进程写库；`session_id`、`search_works`、原生 goal；Windows；网页看板；`baseRef`；收活三件套 `get_worker_diff` / `ask_codex_worker` / `land_codex_worker`；后台自动更新。

下一个：常驻 daemon，派单和进程生命周期从 MCP 进程里拿出来。

不做的：向量检索（子串匹配在这个规模更快、零维护）、`usage_count` 排序（实测 80 个 work 里只有 2 个被回头引用过）。

## 开发

```bash
npm install
npm test               # fake-codex 回放，快且确定
npm run test:edge      # 只跑 test/edge
npm run test:real      # 真 codex CLI 端到端
npm run web:dev        # 看板开发，/api 代理到 7877
npm run web:build      # 打包到 web/dist，发 npm 前自动跑
```

CI 跑 Ubuntu / macOS / Windows，另加一个 Node 22.13.0 的 job 卡 `engines` 下界。

## 参与贡献

看 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题走 [私密通道](https://github.com/zriyox/codex-supervisor-mcp/security/advisories/new)，见 [SECURITY.md](SECURITY.md)。

## License

MIT
