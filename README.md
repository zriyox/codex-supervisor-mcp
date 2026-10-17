# codex-supervisor-mcp

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

官网 [codex-supervisor.zriyo.com](https://codex-supervisor.zriyo.com) · 给模型读的 [llms.txt](https://codex-supervisor.zriyo.com/llms.txt)

让几个 agent 同时改一个仓库，结果是互相覆盖、没人说得清谁改了什么，主线程的上下文还被 worker 的输出塞满。

**codex-supervisor-mcp** 是一个 Codex MCP server，把「派单」和「记账」从模型上下文里拿出来放到磁盘上：一个主线程（Claude Code、Codex 或任何 MCP 客户端）同时指挥多个 Codex CLI worker，一个 worker 一个 Git worktree，状态落盘到 SQLite，附一个网页看板。

![演示：一个 Claude Code 主线程同时派 3 个 Codex worker，各自独立 worktree，并行跑完后合并提交](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 秒真跑：`create_codex_worker` ×3，三个 worker 各自 worktree 并行，主线程收 3 份 diff 合成一次 commit。*

## 解决什么

| 问题 | 做法 |
|---|---|
| 几个 worker 互相踩文件 | 一个 worker 一个 Git worktree，`ownedPaths` 在派单前查冲突 |
| worker 不是只会改代码 | 三种形状：编辑（`ownedPaths` 非空）、只读验证（`read-only` + `ownedPaths: []`，无写入无网络）、研究检索（`workspace-write` + `networkAccess: true` + `ownedPaths: []`，能联网、能写草稿、永不 land）；读共享文件不排他，只有写排他 |
| worker 的过程塞爆主线程上下文 | 事件写 `data/runs/<taskId>.jsonl`，读的时候有 `limit` / `maxChars` / `kinds` 三道闸 |
| 主线程读一次状态就顶满 | `get_orchestration_overview` 把全部 worker 压进 7000 字节 |
| 进程重启后不知道谁还在跑 | `supervisor.sqlite` 一行一个 work，带 `thread_id` |
| 换个会话接不上之前的 worker | `resume_codex_worker` 走 `codex exec resume <thread_id>`，接的是同一个 Codex 会话 |
| 分不清「跑失败」和「进程没了」 | 状态机把 `failed` 和 `lost` 分开 |
| worker 说做完了其实没有 | 派单给 `acceptance` 验收命令，worker 退出后 supervisor 在它的 worktree 里跑，失败 `land` 拒绝 |
| 看不见一批活现在到哪了 | `codex-supervisor-web` 开一个看板，按 session 看每路 worker 在干什么 |
| 改动留在本地没上线 | 收活默认 `land_codex_worker` 合回主分支；主线程自己的改动必须 commit + push；部署前用远端 SHA 核对文件真的在线上 |
| worktree / 分支越堆越多 | `verify_delivery_push` 后自动生成 cleanup plan；只对 `push_verified + clean` 判 SAFE，主线程显式 `apply_cleanup` 才删 worktree，branch/证据永远保留 |

worker 跑的是 `codex exec`，`model` 透传：主线程留在 Claude，worker 可以挂 DeepSeek 或任何 Codex 配了 provider 的模型，账单分开算。

## 五分钟跑起来

前置：Node.js 22.13.0 以上，`codex` CLI 在 `PATH` 里。macOS、Linux、Windows 都行。

### 1. 装

```bash
npm install -g codex-supervisor-mcp
```

npm 全局安装在允许执行安装脚本时，会运行 `postinstall`，给检测到的 Claude Code/Codex 装 skill 并注册 MCP。`--ignore-scripts`、禁用安装脚本或只运行 npx 不保证自动注册；没看到时先运行 `codex-supervisor-setup`，再查两端 `mcp get`。手动注册也可以：

```bash
claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

重启 Claude Code / Codex。以后不用再手动更，见「更新」。只要 skill 不要 MCP：`npx skills add zriyox/codex-supervisor-mcp`。

### 2. 派第一批活

在 Claude Code 里直接说人话，skill 会让它走正确的流程：

> 把这三个模块的单测补齐，用 codex-supervisor 分三路并行跑，session 叫「补单测」。

主线程背后做的事（你也可以自己调工具）：

```
create_codex_worker ×3   每路带 session_id、session_title、ownedPaths、goal
wait_codex_workers       默认等 60 秒，到点返回快照，没完就接着等
get_worker_result ×3     收每路的汇报，带它真跑过的命令和退出码
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
           验证命令同时填 acceptance，supervisor 替你跑，它说过了不算
           worker 交回来先看 diff。它说过了不算，你看到才算
【构建和测试】全走远端机器，本机不跑
【红线】   不改什么，不推什么，不读什么
【必须停下来问我】
【汇报】   中文，表格优先，报哪几项，然后停下来等我
```

主脑一轮下来调的工具：

```
search_works            查这批活派过没有
preflight_codex_worker  同环境跑 probe，确认 sandbox / guard / base / cache 真可用
get_worker_preflight    核 probe 的实际 command evidence；passed 才能派目标 worker
create_codex_worker     一步一个 worker，同一个 session_id，ownedPaths 不重叠
wait_codex_workers      60 秒一轮，compact: true，没完接着调
get_worker_result       它说自己做了什么，verification 里是它真跑过的命令
get_worker_diff         它实际做了什么
ask_codex_worker        对不上就问它为什么，只读，不动它的线程
resume_codex_worker     要改就追一条，让它 amend 进原来那个提交；主线走远了带 rebaseOnto
land_codex_worker       核过了，落进集成分支
```

上一块活 25 步，主脑会话一个人从第 1 步盯到第 25 步，上下文里只有任务书和每路交回来的汇报，没被 worker 的过程撑爆。

为什么一个 worker 只做一步：第 5 步做错了，让做第 5 步的那个 worker `resume_codex_worker` 一下，改完 `--amend` 并回它自己那个提交，主脑再核一次，过了才落进集成分支。要是一个 worker 连做了 5、6、7 三步，第 5 步错了就没法这样改，6 和 7 的提交已经叠在 5 上面，改 5 得连 6、7 一起重做。

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

30 个。

| 工具 | 入参 | 作用 |
|---|---|---|
| `check_workers` | 无参 | 交付新终态、验收失败和需处理goal；新格式第1轮lost/no_work自动恢复一次，未变返回quiet；用宿主定时唤醒调用，每个主线程设独立CODEX_SUPERVISOR_OBSERVER_ID可在重启后接回 |
| `overview_delta` | `cursor` | 主线程默认轮询入口：只返回 active / needs_attention / ready_to_land / ready_to_clean、cursor 后变化和 next_cursor；不返回全量历史、prompt、diff、event 或 worker capsule |
| `check_acceptance` | `cwd`, `acceptance`, `baseRef`, `timeoutMs` | 派单前实际运行给定验收命令，不建 worker，不证明 worker 完成；数量 grep 会提示不能证明失败名单和必跑执行 |
| `preflight_codex_worker` | `cwd`, `ownedPaths`, `probeCommands`, `baseRef`, `sandbox`, `allowedCommands`, `context`, `contracts`, `networkAccess`, `writableRoots` | 用与目标 worker 相同的 base/sandbox/guard 起短 probe worker；它必须实际跑完每条 probe command。等终态后读 `get_worker_preflight` |
| `get_worker_preflight` | `task_id` | 返回 probe 的实际 command evidence、运行环境 contract hash 和 `running/passed/failed`；只有 `passed` 才能复用 |
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `preflight_id`, `forbid`, `allowedCommands`, `context`, `contracts`, `externalOutputs`, `networkAccess`, `writableRoots`, `maxRunMs`, `maxTotalMs`, `acceptance`, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | 起一个 worker。`preflight_id` 给了就必须是通过的同环境 probe，base/guard/context 任何变化都会拒绝派工。`dependsOn` 是硬门禁：上游须同项目、成功结算、验收通过（如配置）、已 land，且本路 base 包含其 landed head |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, 其余同上 | 开一个新会话，把老 worker 的 prompt、状态、近期事件拼进去 |
| `resume_codex_worker` | `task_id`, `prompt`, `rebaseOnto`, `acceptance`, `context` | 接同一个 Codex 会话继续跑，`thread_id` 不变。`rebaseOnto` 先把 worktree 挪到主线新头（stash、跳过已合入补丁、重放新增提交、放回），冲突原样退回不起 worker |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `timeoutMs`, `compact`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | 等终态。默认 60 秒，到点带快照返回，worker 照跑；`compact` 每路只回一行，带 `idle_seconds` / `command_running`，分得清长命令和卡住 |
| `get_orchestration_overview` | `status`, `limit` | 全部 worker 的状态表，封顶 7000 字节。带 `version` 和 `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars`, `includeFiles` | worker 自己的汇报，默认截 6000 字节、`truncated` 提示读全。`acceptance` 是 supervisor 替你跑的验收过没过，`verification` 是它自己跑过的命令和退出码，`base_behind` 是主线走了多远（`contains_base: false` 时 `behind` 为 `null`，那是换了线） |
| `get_worker_diff` | `task_id`, `maxChars`, `paths` | worker 实际改了什么：从 worktree 起点到工作区的 patch，提交没提交都算。`maxChars` 管总量，超了的文件只列名 |
| `ask_codex_worker` | `task_id`, `question`, `timeoutMs`, `maxChars`, `fresh`, `end` | 旁路问 worker 一句。线程 fork 成只读侧会话，没网络、没 MCP 工具，worker 本身不动。worker 被 resume 过会自动换新 fork，`fresh` 强制换，`end` 删 |
| `land_codex_worker` | `task_id`, `onto`, `commitMessage`, `ignoreAcceptance`, `allowOutsideOwned` | 把 worker 在 `codex/<id>` 上的提交 cherry-pick 到派单目录的当前分支。目标要干净，冲突回滚，验收 `failed` 拒绝。`commitMessage` 先替它把未提交的改动提交成一笔，`ignoreAcceptance` 放行 |
| `verify_delivery_push` | `task_id`, `remote`, `branch` | fetch 指定 remote branch 并证明 `landed_head` 已可达；只读验证，不会 push 或部署。通过后记录 `push_verified` 并生成 cleanup plan |
| `cleanup_plan` | `task_ids`, `project_root` | 生成 15 分钟有效的 SAFE / REVIEW / BLOCKED 计划，含原因、fingerprint 与回收空间估算；SAFE 会进入 `cleanup_eligible` |
| `apply_cleanup` | `plan_id`, `item_ids` | 只在未过期计划上二次校验 SAFE item 后执行 `git worktree remove/prune`；保留 branch、task、events、JSONL、artifacts |
| `cleanup_history` | `task_id`, `limit` | 查询 cleanup 的计划、理由、fingerprint 和实际回收记录 |
| `get_worker_summary` | `task_id` | 一段话：goal、状态、改动、最后一条命令和消息 |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | 单个 worker 的状态细节 |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | 原始事件流 |
| `get_context_snapshot_meta` | `task_id` | 只读 worker context 的 snapshot ID、fact IDs、token 估算和排除项；不返回 capsule 正文或历史记录 |
| `get_fact` | `fact_id` | 按 ID 审计一条 candidate/verified fact；不会自动扩展进主线程上下文 |
| `get_worker_goal` | `task_id` | 派单时记的 goal + Codex 原生 goal（token、用时） |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | 列 worker，默认只看在跑的 |
| `get_session_works` | `session_id` | 一个 session 的全部 worker。主线程重启后靠它找回那批活 |
| `describe_session` | `session_id`, `title`, `note`, `objective`, `default_acceptance`, `approval_state`, `expected_revision` | 给 session 记标题和说明 |
| `search_works` | `query`, `limit` | 在 title / goal / prompt / last_message 里找子串，从新到旧 |
| `check_for_update` | `force` | 问 registry 有没有新版本 |
| `cancel_codex_worker` | `task_id` | 终止 worker。跨进程按 pid 兜底，先确认那个 pid 跑的是 codex |

必填的两个：`ownedPaths`（派单前和在跑的 worker 求交集，重叠就拒，只在派单时查）和 `goal.objective`（worker 会建成 Codex 原生 goal）。`session_id` 不传就归不了组，一批活传同一个值。

`acceptance` 在 Bash 中启用 `errexit` 和 `pipefail`：未处理的失败会停止检查，`npm test | tail` 中的测试失败也会保留。写 worker 不能只用 `test -s`、`test -f` 或 `[ -e ]` 这类文件存在性命令交付；要加真实 test、endpoint probe 或结构化执行证据。识别到的 test runner 输出 `no tests to run` / `[no test files]` 时，即使退出码是 0 也判失败。预期失败用 `if` 或 `||` 显式处理；超时始终判失败，即使命令收到终止信号后退出 0。Windows 需要 Git for Windows 的 Bash；找不到会报错。显示的输出会裁剪，退出码不会因此改变。

普通 worker 启动时会关闭它继承到的 `codex-supervisor` MCP，不能再派 worker、resume、cancel 或改编排状态；主线程是唯一编排者。其他业务 MCP 不受影响；旁问 fork 仍关闭全部 MCP，因为它只允许只读回答。

`session_id` 只负责批次、默认门禁和审批，不再把同批 worker 的标题、汇报或 session objective 自动塞进新 worker。worker 只收到内部编译的 context capsule：自身身份/任务、显式依赖和路径/SHA 命中的 verified facts；raw event、完整 diff、历史报告、candidate facts 都只可按需读取。主线程只看 `get_context_snapshot_meta`，需要证据时再显式 `get_fact` / `get_worker_result` / `get_worker_diff`。

worker 的最终 JSON 报告会先记录为该 run 的 `candidate` fact，不能跨 work 自动注入；supervisor acceptance 通过后才生成当前 work 的 `verified` outcome，并带 report/acceptance event 来源、base SHA 与 watched paths。验收失败、未配置验收或 worker 自报完成都不会升级成共享真相。

交付状态分开：acceptance 通过只是 `verified`，`land_codex_worker` 只是 `landed`，仍不代表远端有这笔提交。需要显式 `verify_delivery_push` fetch 并校验 `landed_head` 已在目标 remote branch 上，才是 `push_verified`；它会自动生成 cleanup plan，SAFE 项进入 `cleanup_eligible`，但永远不会自己删除。该工具绝不代替用户执行 push 或部署。

验收命令的环境包含 `CODEX_SUPERVISOR_TASK_ID`、`CODEX_SUPERVISOR_BASE_COMMIT` 和 `CODEX_SUPERVISOR_RUN`；分别是当前任务、当前运行基线和运行次数，rebase/resume 后会更新。

结构化验收项用 `{command, reportPath, baseline}`。baseline 包含 `identity.base_commit`、`failures`（test_id/kind/signature）和 `required`；报告包含 complete、identity、failures、executed、skipped，以及本次 `CODEX_SUPERVISOR_CHECK_ID`。必跑用例缺失/跳过、旧报告、失败名单变化都拒绝通过，原始退出码保留。reportPath 必须在工作目录内；测试报告可能写文件，要用忽略的临时目录，避免把报告合入。

落地前按真实 diff 核对 ownedPaths，越界拒绝且不提交草稿；只有用户明确授权时才用 allowOutsideOwned。

同 session 的 `default_acceptance` 自动加到每路本地检查前；resume 会取最新策略。`describe_session` 返回 policy_revision，改目标/门禁可传 expected_revision 防旧窗口覆盖；waiting_user 拒绝派单与恢复，approved 后再继续。回执host_goal_sync包含按当前策略生成的/goal命令；宿主已有原生goal时用/goal替换条件，支持ProposeGoal时可提议同一条件并走宿主批准。条件要求读取最新session revision及批准范围；MCP不会偷偷修改或禁用宿主Stop hook。

wait 默认预算60秒、默认compact；includeEvents会选择详细结果（显式compact优先）。带progress token的客户端每30秒收到通知；已验证MCP SDK及真实Claude2.1.299：idle35秒、wait65秒，三次progress后正常返回；原生/loop定时调用也已实测。

每路临时注入随包PreToolUse守卫：apply_patch核对全部目标路径（含rename和symlink），forbid拒绝红线；Shell仅允许简单读取和派单显式allowedCommands/acceptance。声明的验证脚本以派单者权限执行，可有副作用，不能当作任意程序的文件沙箱。guard策略随resume/followup继承，不写全局hooks。空跑write run按本轮输出前后内容和命令判断，no_work进入needs_attention；只读任务不因没改文件判空跑。

没有独立 `apply_patch` 工具的模型（实测 Codex 0.162 + DeepSeek/cc-switch）把补丁当 shell 命令发过来：`apply_patch <<'EOF' ... EOF`。守卫认这个形状，用同一套 ownedPaths 规则判每个目标路径，所以这种模型也能改文件；未加引号的 heredoc、后面还接 `&&`/`;` 的都拒绝。

`allowedCommands` 里以 `*` 结尾的条目是前缀匹配（如 `go test ./internal/*` 覆盖 `go test ./internal/service -run TestX`），只对没有 shell 元字符的单条命令生效。编辑器 worker 的只读白名单覆盖 grep/sed（无 `-i`）/find（无 `-exec`/`-delete`）/jq（无 `-i`）/awk、git 只读子命令和 `cmd | head|tail|wc|sort|uniq` 纯读管道；`tee`、重定向、`env` 仍拒。守卫不是文件沙箱，漏网的写入只会落在 worker 自己的 worktree，land 会拒。

守卫按 worker 形状放权：`ownedPaths` 非空的编辑 worker 只放声明过的命令和简单读取；`read-only` 或 `ownedPaths: []` 的 worker 没有可 land 的写边界，Shell 不再逐条限制（forbid 红线照旧），所以检索、审查、跑 `curl`/`gh`/`python` 都能干活。实测 read-only 沙箱连 `/tmp` 都写不了、也不通 DNS，所以联网检索要用 `workspace-write` + `networkAccess: true` + `ownedPaths: []`，产物永不进主分支。

check_workers在状态协调后，对已结束的第1轮lost/no_work/invalid_report原子resume一次（invalid_report只要求重发裸JSON，不重做活）；第2轮仍有问题则保留证据等处理。审批、认证、权限和quota等待不重试，返回recoveries记录。worker最终输出强制JSON result/verification/not_done；get_worker_result的structured_report给格式校验，独立命令与acceptance仍为实际证据。非法JSON标failed/invalid_report并拒绝land；旧历史标legacy_text。

context用绝对文件路径与可选sha256声明材料，最多20份、与contracts合计6000字；文件不超过5 MB。首次派单记录实际哈希，resume校验原材料未变，需要新材料时显式传context。handoff最多1800字/16行，截断明确标记；完整约束和引用单独保留，材料不授予写权限。

确需共享写入时声明externalOutputs:[{path,sha256?}]并配置acceptance。目标必须是绝对文件路径、每份≤1 MB；记录本轮前后哈希和有界内容，result/diff标shared_file_already_written_not_cherry_pick，不能通过land合入外部文件。外部目标参与归属冲突与hook；验证脚本的共享副作用由派单者负责。

workspace-write默认networkAccess:false；需要ssh/联网验证显式true，随resume/followup继承，不以danger-full-access代替。maxRunMs限制单轮、maxTotalMs限制从派单开始的总时长；超限中止worker并保留needs_attention/partial work，不自动重试。wait预算不改变这些quota。

沙箱除工作区和临时目录外，自动放开 OS cache 目录（macOS `~/Library/Caches`、Linux `~/.cache`、Windows `%LOCALAPPDATA%`）、home 下已存在的工具链缓存目录（`.cargo`/`.npm`/`.yarn`/`.pnpm-store`/`.bun`/`.m2`/`.gradle`/`.nuget`/`.ivy2`/`.bundle`/`.composer`/`.pub-cache`/`.mix`/`.hex`/`.stack`/`.cpanm`/`.deno`/`.conda`、`go/pkg`）：Go 的 build cache 这类默认落在 cache 目录的工具链直接可用，换语言也不用改 supervisor；**凭据目录一律不自动放开**（`.ssh`/`.gnupg`/`.config`/`.aws`/`.docker`/`.kube`/`.netrc`/`.git-credentials`/`~/Library/Keychains`）：ssh 连服务器要写 known_hosts、kubectl、推私有镜像、签名提交这类需求，派单时显式传 `writableRoots`，只在这一路生效。`SUPERVISOR_NO_AUTO_CACHE_ROOTS=1` 关掉全部自动缓存根，显式声明的照常生效。Codex 拒绝带软链的可写根（这种根会让 worker 所有命令都失败），所以 cache 目录和 `writableRoots` 都先按 realpath 解析，解析不出无软链路径的根直接不带。cache 放在别处（`~/.m2`、`~/.gradle`、vendor 镜像）就传 `writableRoots:[绝对路径]`，要求是已存在目录、最多 20 个、只对 workspace-write 生效、随 resume/followup 继承；只读复用就不用传。

运行前核验Codex CLI是否具备hooks/output-schema（要求0.162+）；能力不足返回start_failed，wait可正常结算。get_worker_goal.native_goal_read区分missing_goal、missing_database、locked和read_error，不能把读取失败当没建goal。原生budget/usage限制也进入needs_attention。cleanup保留ignored artifacts、共享证据和未解决attention。

ownedPaths预留和任务入库在同一事务内，跨MCP并发派单/恢复不能抢同一输出；验收或退出尚未结算时仍保留归属。Git工作区隔离创建失败明确报错，不退回主目录执行。

清理先 `cleanup_plan`（CLI 对应 `npm run cleanup -- --dry-run`）分类 SAFE / REVIEW / BLOCKED；SAFE 要求 `push_verified`、干净、无活跃依赖、Git 注册和路径归属可证明。`apply_cleanup`（CLI `--apply`）会在删除前重验 fingerprint，只执行 `git worktree remove`/`prune`。branch、task row、event、JSONL、artifact 永远保留；脏、未合、未 push、lost/failed 和证明不足的一律不删。

## 和 Claude Code 的 subagent 有什么区别

文件隔离不是差别：subagent 自己也能开 worktree。差别在模型和进程。

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| 能跑什么模型 | 只能选 Claude | `model` 透传给 Codex CLI，DeepSeek 也能挂 |
| 干活的是谁 | Claude Code 自己 | 独立的 `codex exec` 进程 |
| 两路写同一个文件 | 靠 worktree 隔开，没有路径声明 | 派单前查 `ownedPaths` 交集，重叠直接拒 |
| 主线程进程挂了 | 主窗口无法收活 | 独立运行进程继续记录 worker 和验收；新窗口用 session_id 收回同批结果 |
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
| `lost` | worker 被外部信号杀掉、运行进程失踪、或者行写了但进程从没起来。`resume_codex_worker` 接回 |

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

GUI 客户端（Claude Desktop、Cursor、Windsurf）不在本安装器的自动注册目标中，自己把这段加进它的 MCP 配置文件，`PATH` 里常常没有 `codex`，显式给 `CODEX_BIN`：

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

装失败（全局目录要 sudo）时 `update` 字段带原因，手动 `npm install -g codex-supervisor-mcp@latest`。0.6.1 及以前只提醒不自动装，手动升一次就进自动了。换 Node/安装前缀后，setup 会修复本包生成的旧入口，并读回核对 command/args；已有自定义、disabled、project配置保留并提示处理，不擅自覆盖。重跑安装：`codex-supervisor-setup`（`--skill-only` / `--mcp-only` / `--dry-run`）。手动注册失败返回非0，自动安装保持成功但打印warning；skill写入失败仍继续尝试MCP注册；没找到CLI时可设 `CLAUDE_BIN` / `CODEX_BIN`。skill路径跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。

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
| worker `lost` | worker 或独立运行进程中断 | 查事件后用 `resume_codex_worker` 接回 |
| worker 说 `git add` 报 `index.lock: Operation not permitted` | 默认沙箱把 `.git` 设成只读 | 收活时 `land_codex_worker` 带 `commitMessage`，或派单用 `danger-full-access` |
| `ownedPaths overlap with active worker(s)` | 两路认领了同一片路径 | 改拆法，或先取消占着的那路 |
| 看板打开是空的 | 看板和 MCP 的 `SUPERVISOR_HOME` 不是同一个 | 在配了 `.mcp.json` 的项目目录里起，或显式传同一个 `SUPERVISOR_HOME` |
| `port 7877 ... is already in use` | 已经有一个看板在跑 | 直接开它，或 `SUPERVISOR_WEB_PORT=8080` 再起一个 |

## 已知限制

- 每次运行由独立进程读取 worker 输出、落状态和执行验收，直到结算后退出。派单 MCP 被 kill 后这些工作继续；新窗口用 `get_session_works` 收结果。若运行进程也被杀，保留 worktree 和 thread_id，核对 lost/interrupted 后恢复。
- 默认 `workspace-write` 沙箱里 worker 提交不了（Codex 把 `.git` 设成只读）。要么收活时 `land_codex_worker` 带 `commitMessage` 替它提交，要么派单用 `danger-full-access`。
- worktree 从一个提交切，你工作区里没 commit 的东西不在里面。
- 只隔离工作目录。临时目录、数据库、端口是共用的。
- `ownedPaths` 只在派单时查，拦不住 worker 新建清单外的文件。收活看 diff。
- 验收是 `acceptance` 里写了什么就查什么。没写的事它不会替你查，`verification` 只是 worker 自己跑过的命令，剩下的靠主线程看 diff。
- 一次 `wait_codex_workers` 等不到底，客户端的 MCP 工具超时是硬墙，靠反复调。
- `search_works` 是子串匹配，几百条够用。

## Roadmap

做完的：`CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN`；`status` 和 `phase` 拆开；`ownedPaths` / `goal` / `dependsOn`；`thread_id` 落库 + `resume_codex_worker`；并发和多进程写库；`session_id`、`search_works`、原生 goal；Windows；网页看板；`baseRef`；收活三件套 `get_worker_diff` / `ask_codex_worker` / `land_codex_worker`；后台自动更新。

运行生命周期已独立于 MCP；每路结算后退出，不需要常驻全局 daemon。

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
