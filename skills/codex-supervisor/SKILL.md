---
name: codex-supervisor
description: 把 Codex CLI 当并行 worker 派活、盯进度、收结果。用户说"派 codex 干""并行跑""开几个 worker""这批活分几路""多 agent 做"时用；工作线程断了要接回来、要查以前派过什么活，也用这个。
---

# codex-supervisor

主线程派活给 Codex worker，一个 worker 一个独立 Git worktree，状态全部落盘。

## 什么时候用

一批能拆开的活、活偏大不想占自己的上下文、跑到一半可能断要能接回来。一个文件的小改、纯问答、要来回确认的活，自己干更快。

## 派单

1. 先 `search_works` 搜一下，别重复派。
2. 拆活。每路写清楚：干什么、能写哪些文件、怎么算做完。改同一批文件就串行，文件完全不重叠才并行。
3. `create_codex_worker` 派出去。回执只有 `id`、`worktree_path`、`branch`、`owned_paths`、`status`，不回传任务原文。
4. `wait_codex_workers` 等。默认 2 分钟，到点返回快照，worker 照跑；拿同一批 `task_ids` 接着调到 `timed_out: false`。只想知道完没完带 `compact: true`。

| 参数 | 怎么填 |
|---|---|
| `task` | 这一路具体干什么。要能直接开工，别写"优化一下"。汇报格式 supervisor 已经附在 task 后面（结论 / 验证 / 没做的），别再要它列改动文件，diff 自己看 |
| `cwd` | 项目根目录。worker 在自己的 worktree 里干活，不动你的工作区 |
| `acceptance` | 这一步"做完了"的判据，shell 命令列表，worker 退出后 supervisor 在它的 worktree 里逐条跑，退出码 0 算过，worker 在 prompt 里看得到。任务书里的验证命令原样抄：查那个文件在不在、那个接口通不通、那个测试文件过不过。写能判这一步的，不写全仓回归；远端机器的检查包进 `ssh`。命令用 supervisor 自己的权限跑，等于你自己跑 |
| `ownedPaths` | 必填。这路允许写的路径，和在跑的 worker 重叠会被拒。冲突是好事，说明该改拆法 |
| `goal.objective` | 必填。一句话说目标，worker 会建成 Codex 原生 goal |
| `session_id` | 同一批传同一个值。第一路顺手带 `session_title`（30 字内，看板和 `get_session_works` 显示它），漏了用 `describe_session` 补 |
| `dependsOn` | 有先后依赖填上游的 `task_id` |
| `baseRef` | worktree 从哪个提交切，默认 `HEAD`。第 N+1 步要建立在第 N 步上，填 `codex/<第 N 步 task_id>` |
| `sandbox` | 默认 `workspace-write`，worker 提交不了（Codex 把 `.git` 设成只读）。要它自己提交就 `danger-full-access`，否则收活时让 supervisor 替它提交 |

等待的几条规矩：

- 等待预算管这次调用，不管 worker。`still_running: true` 是等满了不是挂了，按 `next_step` 再调。
- 快照里 `idle_seconds` 是距上一条 Codex 事件多久，命令跑着和模型思考时 Codex 都不发事件。`command_running: true` 是长命令（`current_command` 是哪条），接着等；`command_running: false` 且 idle 超过 10 分钟，`get_codex_worker_events` 看最后几条，进程没了状态机会自己标 `lost`。
- `timeoutMinutes` 别超过客户端的 MCP 工具超时，否则被掐的是这次调用。
- **不要自己写 shell 循环 grep `data/runs/*.jsonl`**。进程被杀、`failed`、`lost`、`exit_code` 只有状态机知道，文件里没有；resume 过的 worker 文件里有多条 `turn.completed`；用户在终端里看到的是一行黑盒。
- 想省上下文改调 `get_orchestration_overview`，封顶 7000 字节。

## 收活：先看证据，再问，再改，再落

0. 先看 `acceptance`（compact wait、overview 的 `acceptance_failed`、`get_worker_result.acceptance` 都有）。`failed`：不用读它的汇报，直接走第 4 步，把 `checks[].output_tail` 原样贴进 resume 的 prompt。`passed` 但它说没做成、goal 是 `blocked`：信命令不信它，去看 diff。命令本身写错了，resume 带新的 `acceptance` 换掉，别 `ignoreAcceptance`。`null` 是没配，退出码只说明没崩，对不对自己看。
1. `get_worker_result`：它说自己做了什么。默认截到 6000 字节，`truncated: true` 就按 `next_step` 带 `maxChars` 读全。`verification` 是它真跑过的命令和退出码：说"测过了"但 `commands_run: 0`、说"没建成"但那条命令退出码是 0、`last_command_failed: true` 却说完成、说"环境问题"但 `failed[].output_tail` 里是代码报错，都打回（走第 4 步），别替它圆。`base_behind.behind > 0` 说明派单后主线往前走了，改之前先 rebase（第 4 步）。
2. `get_worker_diff`：它实际做了什么。起点到工作区的全部改动，提交没提交都算；`maxChars` 管总量，`paths` 缩范围。它说过了不算，diff 对得上才算。
3. 对不上、看不懂为什么：`ask_codex_worker` 带 `question` 问它。fork 出一个只读旁路，worker 自己的线程不动；fork 没网络没 MCP 工具，问"改了什么、为什么、在哪"，别问要联网才能答的事。超时回 `running`，只带 `task_id` 再调拿答案。worker 被 resume 过后下一问自动换新 fork，`fresh: true` 强制换，问完 `end: true` 删。
4. 要它改：`resume_codex_worker`，写清问题在哪，让它改完 `git commit --amend --no-edit` 并进原来那个提交。旁路只读，改东西永远走 resume。主线往前走过（`base_behind.behind > 0`）就带 `rebaseOnto: "HEAD"`（在派单目录里解析）：未提交的改动先 stash，它自己的提交重放到新头，stash 放回，`base_commit` 跟着动。冲突（`rebase_conflict` / `stash_conflict`）会原样退回、不起 worker、`files` 列冲突文件；这时让它先 `land_codex_worker` 带 `commitMessage` 提交成一笔再 rebase，或者重派一路 `baseRef` 填新头。
5. 过了：`land_codex_worker` 把 `codex/<id>` 上的提交 cherry-pick 到派单目录当前分支。目标脏了、分支不对、冲突都拒绝并原样退回。worker 没提交（默认沙箱提交不了）就带 `commitMessage`，supervisor 在它分支上替它提交一笔再落。验收 `failed` 它会拒，修完再落；`ignoreAcceptance` 只在用户说了"就这样落"时用。

一批活全部到终态后：`get_orchestration_overview` 确认没有 `needs_attention`、`acceptance_failed` 为空，再逐路走上面几步。合不合、怎么合由主线程定。

高风险的步（迁移、改公共接口、"做完了"写不成命令的）再派一路 verifier：`sandbox: "read-only"`、`ownedPaths: []`，task 只给这一步的目标和原 worker 的 `worktree_path`，不给它的汇报，不说你怀疑什么，让它答"目标达成没有，证据是哪几行"。它不改东西，只读只跑。两路说法对不上，两边都别信，自己看 diff。

## 读结果别把上下文撑爆

| 想干什么 | 用哪个 |
|---|---|
| 全部 worker 的状态 | `get_orchestration_overview` |
| 一路的完整结论 | `get_worker_result` |
| 一路改了什么 | `get_worker_diff`；只要文件名用 `get_worker_result` 带 `includeFiles: true` |
| 活着还是完了 | `get_worker_summary` |
| 过程 | `get_codex_worker_events`，`kinds` 先滤、`limit` 限条数、`maxChars` 截长串，先看 `available_kinds` |
| 一路的状态细节 | `get_codex_worker_status`，`current_action` 是它正在跑的命令 |
| 验收过没过 | 每个读都带 `acceptance`；命令和每条的输出在 `get_worker_result.acceptance.checks` |

默认读回来的长文本都是裁过的（`current_action` 300 字、`prompt` 300 字、`last_message` 400 字），别把裁剪当成活没干。全量在库里。别一次 `limit: 200` 拉全量事件。

## 断了怎么接

| 情况 | 用什么 |
|---|---|
| 主线程自己挂了 | 先 `get_session_works({ session_id })`，一次拿回那批活 |
| worker 变 `lost`（MCP 进程没了把它带走了，或被信号杀了） | `resume_codex_worker`。worktree 里的改动和 `thread_id` 都在，同一线程接着干；被杀时正在做的那一步可能要重做 |
| worktree 落后主线（`base_behind.behind > 0`） | `resume_codex_worker` 带 `rebaseOnto: "HEAD"`，见收活第 4 步 |
| worker `failed` | 看 `error` 和日志，查完再 resume 或重派 |
| 没记到 `thread_id` 的老行 | `create_codex_followup_worker`，新线程靠文本重述 |

`status` 是生命周期：`queued` / `running` / `completed` / `failed` / `cancelled` / `lost`。`phase` 只在跑着时有值：`starting` → `thinking` → `command` → `editing` → `reporting`。`completed` 配 `exit_code: null` 是中间态，`wait` 会等到退出码落了再返回。goal 的 `paused` / `blocked` 不是结束，是等人管，overview 会列进 `needs_attention`。

## 看到 `update` 字段就转告用户

overview、派单回执、`wait` 返回里出现 `update` 且 `update_available: true` 时，当轮回复里照 `notice` 告诉用户一句。`auto_update.state` 是 `started` / `running` / `done` 时新版已在后台装，重开会话即可；`install_command` 有值才让用户自己跑。只说一次。

## 常见坑

- worktree 从一个提交切，你工作区里没 commit 的东西 worker 看不到。要让它读到就给绝对路径或先 commit。
- `exit_code: 0` 只说明没崩。`acceptance` 是 supervisor 替你跑的验收，`verification` 是它自己跑过的，两个都没有就只剩 diff。验收命令别往 worktree 写文件，会混进它的改动。
- `ownedPaths` 是派单前的冲突检测，不是运行时沙箱，拦不住 worker 新建清单外的文件。收活看 diff。
- worktree 只隔离工作区，端口和数据库是共用的。
- `resume_codex_worker` 不会再建 goal。`cancel_codex_worker` 跨进程靠 pid，要求那个 pid 的命令行里带 `codex`。

## 看板

用户想用眼睛看就让他起 `codex-supervisor-web`（或 `npx -p codex-supervisor-mcp codex-supervisor-web`），开 `http://127.0.0.1:7877`。按 session 分组，每路有「旁问」tab，用户可以自己问 worker。
