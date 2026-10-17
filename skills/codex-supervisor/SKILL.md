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
2. 拆功能包。每路写清楚：干什么、能写哪些文件、依赖谁、怎么算做完和谁负责集成。改同一批文件就串行；文件不重叠只是并行前提，不等于依赖已满足。
3. 写 worker 先 `preflight_codex_worker`：用目标同一份 `workspaceKind` / `baseRef` / `ownedPaths` / `sandbox` / `allowedCommands` / `context` / `networkAccess` / `writableRoots` 跑必要命令。等它终态后 `get_worker_preflight` 必须 `passed`，再把它的 `task_id` 填进 `create_codex_worker.preflight_id`。contract 变了重跑，不能拿宿主 `check_acceptance` 冒充 worker 环境成功。
4. `create_codex_worker` 派出去。回执只有 `id`、`worktree_path`、`branch`、`owned_paths`、`status`，不回传任务原文。
5. 长任务配宿主 `/loop 5m check_workers` 定时收活，没变化 quiet，有新结果按 next_step 收。工具会按规则恢复一次，但不会唤醒关闭的主窗口；每个主线程设独立 `CODEX_SUPERVISOR_OBSERVER_ID` 可重启接回。短等用 `wait_codex_workers` 的 `timeoutMs: 60000`、`compact: true`，到点继续同批 task_ids。

worker 默认不是调度员：启动时会禁用它继承到的 `codex-supervisor` MCP，不能再派 worker、resume、cancel 或改 session。要拆新路只能主线程决定并派；业务 MCP 仍按原配置可用。旁问 fork 则关闭全部 MCP。

| 参数 | 怎么填 |
|---|---|
| `task` | 这一路具体干什么。要能直接开工，别写"优化一下"。汇报格式 supervisor 已经附在 task 后面（结论 / 验证 / 没做的），别再要它列改动文件，diff 自己看 |
| `cwd` | Git 项目根，或非 Git 输入目录；实际执行目录由 `workspaceKind` 决定，不能默认写原目录 |
| `workspaceKind` | Git 代码默认 `git_worktree`；非 Git 只读用 `read_only_in_place`，联网研究用 `scratch`，要改用户非 Git 目录只能显式 `in_place_write` |
| `inPlaceAuthorization` | 仅 `in_place_write`：写明用户授权原因；同时必须有非空 `ownedPaths` 和 `acceptance`，系统记录前后 manifest |
| `acceptance` | 这一步"做完了"的判据，worker 退出后 supervisor 在它的 worktree 里逐条跑。写 worker 不能只用 `test -s/-f`、`[ -e ]` 这类文件存在性检查；要有真实 test、endpoint probe 或结构化执行证据。识别到的 test runner 输出 `no tests to run` / `[no test files]` 即使 exit 0 也失败。必跑用例、skip、旧报告和失败身份用 `{command,reportPath,baseline}` 结构化验收证明；远端机器的检查包进 `ssh` |
| `forbid` / `allowedCommands` | 原样声明红线与验证命令；守卫拒绝未声明Shell程序，编辑用apply_patch |
| `writableRoots` | 只有需要凭据目录时才传（绝对路径、已存在、自动解析软链、只对 workspace-write 生效）：ssh/远程测试 → `["~/.ssh"]`；kubectl → `["~/.kube"]`；推私有镜像 → `["~/.docker"]`；aws cli → `["~/.aws"]`；签名提交 → `["~/.gnupg"]`。缓存目录不用写，已经自动加 |
| `ownedPaths` | 必填。这路允许写的路径，和在跑的 worker 重叠会被拒（**读不排他**，多路读同一份共享文件合法）。冲突是好事，说明该改拆法。传 `[]` 表示这路不落地：只读验证或研究 |
| `goal.objective` | 必填。一句话说目标，worker 会建成 Codex 原生 goal |
| `session_id` | 同一批传同一个值。只管批次、默认验收和审批，不是上下文继承边界；第一路顺手带 `session_title`（30 字内，看板和 `get_session_works` 显示它），漏了用 `describe_session` 补 |
| `dependsOn` | 有先后依赖填上游的 `task_id`，它是硬门禁：上游必须同 `project_root`、成功结算、配置了 acceptance 就已通过、已 `land_codex_worker`，并且本路实际 `baseRef` 包含上游 `landed_head`。没满足先集成/修验收，不会启动下游 |
| `baseRef` | worktree 从哪个提交切，默认 `HEAD`。第 N+1 步要建立在第 N 步上，填 `codex/<第 N 步 task_id>` |
| `preflight_id` | 写 worker 必填。先跑 `preflight_codex_worker`，它实际在目标 sandbox/guard 里执行 `probeCommands`；`get_worker_preflight.status` 必须是 `passed`。base、ownedPaths、命令、context、contracts、network、可写根有变化就重跑 |
| `sandbox` | 默认 `workspace-write`，worker 提交不了（Codex 把 `.git` 设成只读）。要它自己提交就 `danger-full-access`，否则收活时让 supervisor 替它提交 |

验收用 Bash 的 `errexit` + `pipefail`：`npm test | tail` 不能吞失败；文件存在只可做附加门禁，不能单独证明业务完成。预期失败用 `if` / `||` 显式判。超时、`no tests to run`、`[no test files]` 都失败，别只看退出码 0。Windows 要有 Git for Windows Bash；缺失先修工具，别换回 cmd。

验收取当前身份用 `CODEX_SUPERVISOR_TASK_ID` / `CODEX_SUPERVISOR_BASE_COMMIT` / `CODEX_SUPERVISOR_RUN`；不要在命令里写死旧 base，rebase/resume 后这些值会更新。

`check_acceptance` 只是在宿主权限跑验收命令，预检通过不代表 worker sandbox/guard/PATH/cache/network 可用；写 worker 的实际环境预检必须走上面的 `preflight_codex_worker`。已知失败必须按结构化 baseline 的用例名/类型/签名比，必跑项写 required；报告必须标本次 `CODEX_SUPERVISOR_CHECK_ID`，给 complete/identity/failures/executed/skipped，缺失、跳过和旧报告都不算过。reportPath 用工作区内忽略的临时目录，验收报告别混进业务提交。

同批公共门禁用 `describe_session.default_acceptance`，自动追加本路验收；更新目标/门禁传 `expected_revision`，避免旧窗口覆盖。需要用户拍板时设 `approval_state: waiting_user`，不得自动resume；获批改approved并同步宿主goal。回执host_goal_sync给当前策略的/goal命令；宿主已有原生goal时，用/goal替换条件，支持ProposeGoal时提议同一condition并走宿主批准。这个条件要求读取最新session revision，批准旧失败或waiting_user后不再追旧目标；工具不偷偷改/禁用Stop hook。

wait默认60秒和compact，带includeEvents则详细返回；客户端带progress token时每30秒收到通知。已实测Claude2.1.299在35秒idle下收到三次progress，65秒wait正常返回；通知不能唤醒关闭的宿主。/loop实测可定时调用，主窗口须保持运行。

派单写forbid红线、allowedCommands验证命令；runtime守卫按次注入并随resume/followup继承。apply_patch核对ownedPaths，Shell仅放简单读取和显式声明的验证命令；声明脚本可以有副作用，须先核对，不能当万能文件沙箱。no_work表示本轮write无输出变化且没跑命令；先看run_evidence，不拿上轮提交/命令当本轮完成。

没有独立 `apply_patch` 工具的模型会把补丁当 shell 命令发过来（`apply_patch <<'EOF' ... EOF`）：守卫认这个形状，按同一套 ownedPaths 判路径、同样拒越界，所以模型不需要有那个工具也能改文件。Quoted heredoc 才认；后面跟 `&&`/`;` 的、未加引号的都不算。

`allowedCommands` 里以 `*` 结尾的条目是**前缀**：声明 `go test ./internal/*` 就覆盖 `go test ./internal/service -run TestX`，但只对没有 shell 元字符的单条命令生效（`; rm -rf /` 不会通过）。守卫的只读白名单包含 grep/sed/find/jq/awk/go env、git 的只读子命令和 `cmd | head|tail|wc|sort|uniq` 这类纯读管道；`sed -i`、`find -delete/-exec`、`jq -i`、`tee`、重定向仍被拒。

worker不止改代码，按这路要什么选形状：

| 形状 | 参数 | 能干什么 |
|---|---|---|
| Git 编辑 worker | `workspaceKind: "git_worktree"` + `ownedPaths` 非空 | apply_patch 只能落在 ownedPaths，shell 只放声明过的命令和简单读取 |
| 只读验证 worker | `workspaceKind: "read_only_in_place"` + `sandbox: "read-only"` + `ownedPaths: []` | 随便跑读命令（rg/cat/git/jq），**沙箱没有任何写入（连 /tmp 都不行）、也没有网络**；结论写在最终报告 |
| 研究/检索 worker | `workspaceKind: "scratch"` + `sandbox: "workspace-write"` + `networkAccess: true` + `ownedPaths: []` | 能联网 curl/gh，只能往 supervisor 管理 scratch 写草稿；没有任何东西会 land，也不碰原始非 Git 目录 |
| 非 Git 写入 worker | `workspaceKind: "in_place_write"` + 授权 + `ownedPaths` + `acceptance` | 仅用户明确授权时使用；记录授权和前后 manifest，不能 land |

read-only 下 `networkAccess: true` 会被拒（实测该沙箱连 DNS 都不通，配了也没用）；要联网就按 `scratch` 研究 worker 派。非 Git `workspace-write` 不写 `workspaceKind` 会拒绝，绝不偷偷落到用户目录。研究 worker 的 shell 不受 allowedCommands 限制，forbid 红线照旧。读共享文件永远不排他，只有写按 ownedPaths 排他。

check_workers可对已死的第1轮lost/no_work/invalid_report自动resume一次，recoveries记动作；invalid_report只让它重发裸JSON、不重做活，第2轮仍失败看证据处理，审批/认证/权限/quota不盲重试。最终报告强制JSON，structured_report仅验证格式；invalid_report拒land，resume让模型提交合法JSON，命令和acceptance另外核对。

未提交材料用context:[{path:绝对路径,sha256:可选}]；首次记哈希，resume材料变了要显式换context。context/contracts总6000字、最多20份文件，每份≤5 MB；handoff1800字/16行可裁，完整约束和refs另传。输入路径不等于写授权。

共享写入必须externalOutputs:[{path,sha256?}]+acceptance；绝对文件每份≤1 MB，参与归属冲突/hook。看external_outputs的前后内容、哈希与验收；外部文件已经写在共享目录，不用land，不能拿空worktree diff否认成果。

远端编译/ssh在workspace-write显式networkAccess:true，默认false，resume/followup继承；不要用danger-full-access代替联网配置。需要时声明maxRunMs/maxTotalMs，超限保留partial work并提示处理，不自动恢复；wait预算与quota分开。

沙箱只放工作区、临时目录、OS cache目录（macOS ~/Library/Caches、Linux ~/.cache、Windows %LOCALAPPDATA%）以及home下已存在的工具链缓存目录（.cargo/.npm/.yarn/.pnpm-store/.bun/.m2/.gradle/.nuget/.ivy2/.bundle/.composer/.pub-cache/.mix/.hex/.stack/.cpanm/.deno/.conda、go/pkg）：Go 这类默认把build cache写那儿的工具链不用再单独设 GOCACHE，加语言也不用改supervisor；**凭据目录一律不自动放开**（.ssh/.gnupg/.config/.aws/.docker/.kube/.netrc/.git-credentials/~/Library/Keychains）：ssh 连服务器要写 known_hosts、kubectl、推私有镜像、签名提交这类需求，派单时按参数表显式传 writableRoots，只在这一路生效、随 resume/followup 继承。SUPERVISOR_NO_AUTO_CACHE_ROOTS=1 关掉全部自动缓存根，显式声明的照常生效。Codex 拒绝含软链的可写根（给了这种根worker连命令都起不来），所以cache目录和writableRoots都会被realpath解析后再交给沙箱；解析不到无软链路径就直接不带这个根。cache在别处（如 ~/.m2、~/.gradle、vendor镜像）就传 `writableRoots:[绝对路径]`（已存在目录、最多20个、只对workspace-write生效、随resume/followup继承）；能只读复用就不用传。

Codex需0.162+支持hooks/output-schema，能力不够派单start_failed先修CLI。goal查询看native_goal_read，missing与locked/read_error分开；budget/usage限制也要处理。cleanup保留ignored成果、共享证据及未解决attention。

等待的几条规矩：

- 等待预算管这次调用，不管 worker。`still_running: true` 是等满了不是挂了，按 `next_step` 再调。
- 快照里 `idle_seconds` 是距上一条 Codex 事件多久，命令跑着和模型思考时 Codex 都不发事件。`command_running: true` 是长命令（`current_command` 是哪条），接着等；`command_running: false` 且 idle 超过 10 分钟，`get_codex_worker_events` 看最后几条，进程没了状态机会自己标 `lost`。
- `timeoutMinutes` 别超过客户端的 MCP 工具超时，否则被掐的是这次调用。
- **不要自己写 shell 循环 grep `data/runs/*.jsonl`**。进程被杀、`failed`、`lost`、`exit_code` 只有状态机知道，文件里没有；resume 过的 worker 文件里有多条 `turn.completed`；用户在终端里看到的是一行黑盒。
- 想省上下文改调 `get_orchestration_overview`，封顶 7000 字节。

## 收活：先看证据，再问，再改，再落

0. 先看 `acceptance`（compact wait、overview 的 `acceptance_failed`、`get_worker_result.acceptance` 都有）。`failed`：不用读它的汇报，直接走第 4 步，把 `checks[].output_tail` 原样贴进 resume 的 prompt。`passed` 但它说没做成、goal 是 `blocked`：信命令不信它，去看 diff。命令本身写错了，resume 带新的 `acceptance` 换掉，别 `ignoreAcceptance`。`null` 是没配，退出码只说明没崩，对不对自己看。
1. `get_worker_result`：它说自己做了什么。默认截到 6000 字节，`truncated: true` 就按 `next_step` 带 `maxChars` 读全。`verification` 是它真跑过的命令和退出码：说"测过了"但 `commands_run: 0`、说"没建成"但那条命令退出码是 0、`last_command_failed: true` 却说完成、说"环境问题"但 `failed[].output_tail` 里是代码报错，都打回（走第 4 步），别替它圆。`base_behind.behind > 0` 说明派单后主线往前走了，改之前先 rebase（第 4 步）；`contains_base: false` 时 `behind` 是 `null` 并带 `note`，那是派单目录换了线，不是落后。
2. `get_worker_diff`：它实际做了什么。起点到工作区的全部改动，提交没提交都算；`maxChars` 管总量，`paths` 缩范围。它说过了不算，diff 对得上才算。
3. 对不上、看不懂为什么：`ask_codex_worker` 带 `question` 问它。fork 出一个只读旁路，worker 自己的线程不动；fork 没网络没 MCP 工具，问"改了什么、为什么、在哪"，别问要联网才能答的事。超时回 `running`，只带 `task_id` 再调拿答案。worker 被 resume 过后下一问自动换新 fork，`fresh: true` 强制换，问完 `end: true` 删。
4. 要它改：`resume_codex_worker`，写清问题在哪，让它改完 `git commit --amend --no-edit` 并进原来那个提交。旁路只读，改东西永远走 resume。主线往前走过（`base_behind.behind > 0`）就带 `rebaseOnto: "HEAD"`（在派单目录里解析）：未提交的改动先 stash，跳过已合入的补丁，只把新增提交重放到新头，stash 放回，`base_commit` 跟着动。冲突（`rebase_conflict` / `stash_conflict`）会原样退回、不起 worker、`files` 列冲突文件；这时让它先 `land_codex_worker` 带 `commitMessage` 提交成一笔再 rebase，或者重派一路 `baseRef` 填新头。
5. 过了：`land_codex_worker` 把 `codex/<id>` 上的提交 cherry-pick 到派单目录当前分支。目标脏了、分支不对、冲突都拒绝并原样退回。worker 没提交（默认沙箱提交不了）就带 `commitMessage`，supervisor 在它分支上替它提交一笔再落。验收 `failed` 它会拒，修完再落；`ignoreAcceptance` 只在用户说了"就这样落"时用。

一批活全部到终态后：`get_orchestration_overview` 确认没有 `needs_attention`、`acceptance_failed` 为空，再逐路走上面几步。合不合、怎么合由主线程定。

高风险的步（迁移、改公共接口、"做完了"写不成命令的）再派一路 verifier：`sandbox: "read-only"`、`ownedPaths: []`，task 只给这一步的目标和原 worker 的 `worktree_path`，不给它的汇报，不说你怀疑什么，让它答"目标达成没有，证据是哪几行"。它不改东西，只读只跑。两路说法对不上，两边都别信，自己看 diff。


## 收工口径：活儿必须落地

**"文件写好了"不等于交付。** 本地 worktree / 未提交改动 / 未 push 的 commit，线上都看不到 —— 部署会因为缺类、缺文件、缺 bean 直接挂。派单和主线程自己的改动都按这四条走：

1. **worker 的产出默认要合并**：每个终态 worker 走 `get_worker_result` → `get_worker_diff`，过了就 `land_codex_worker`（sandbox 是 workspace-write 的 worker 没提交，带 `commitMessage` 一起提交再落）。不合并必须在报告里写清原因（验收失败 / 越界 / 等审批），不能默认留在 codex/<id> 分支上。
2. **主线程自己的改动必须 add + commit + push**：`git add <paths> && git commit -m ... && git push`。跳过任何一步都要显式说明，不允许说"改好了"然后留在工作区。
3. **上线前核对远端，不认本地**：部署或重启服务前先 `git fetch`，再确认目标提交里真有那些改动 —— `git log --oneline origin/<branch> -1`、`git ls-tree -r --name-only origin/<branch> | rg <新文件>`、必要时 `git show origin/<branch>:<path>`。线上报 `NoSuchBeanDefinition`、找不到类/模块、404，先查这一条，再查代码逻辑。
4. **交付报告三件套**：本地改动 → commit SHA → push 后的远端 SHA（以及部署状态）。缺远端 SHA 就不算完成。
5. **push 后计划清理**：`land_codex_worker` 只到本地集成；用户 push 后先 `verify_delivery_push`，它会生成 15 分钟有效的 `cleanup_plan`。只对「push_verified + worktree 干净 + 无活跃依赖 + Git 注册/归属可证明」标 SAFE，并进 `cleanup_eligible`；主线程复核 item 后才 `apply_cleanup(plan_id,item_ids)`。apply 前再验 fingerprint，只执行 `git worktree remove/prune`；**branch、task、event、JSONL、artifact 永远保留**。脏、未合、未 push、lost、failed、证明不足是 BLOCKED/REVIEW，禁止强删。`check_workers` 只提醒，不执行删除。

`land_codex_worker` 只到本地集成 `landed`，不是远端交付。用户已经 push 后，主线程调 `verify_delivery_push({task_id,remote:"origin"})`，它只 fetch + 祖先校验、不替你 push/部署；通过才记 `push_verified`，后续才可进入安全 cleanup 候选。

典型事故：两个实现类只存在于主线程的 worktree 里，没 add / 没 commit / 没 push，线上跑的还是上一个提交，Spring 找不到 bean 启动失败 —— 不是代码错，是没上线。

多 worktree 场景同理：worker 的分支、主线程的改动、集成 worktree 的合并，三者都要各自 push 到远端；只在自己 worktree 里"跑通了"不算。


## 读结果别把上下文撑爆

| 想干什么 | 用哪个 |
|---|---|
| 主线程日常增量 | `overview_delta`，保存 `next_cursor`；只看计数和变化 task 摘要 |
| 全部 worker 的状态 | `get_orchestration_overview`，只在需要全量状态时用 |
| 一路的完整结论 | `get_worker_result` |
| 一路改了什么 | `get_worker_diff`；只要文件名用 `get_worker_result` 带 `includeFiles: true` |
| 活着还是完了 | `get_worker_summary` |
| 过程 | `get_codex_worker_events`，`kinds` 先滤、`limit` 限条数、`maxChars` 截长串，先看 `available_kinds` |
| 一路的状态细节 | `get_codex_worker_status`，`current_action` 是它正在跑的命令 |
| 验收过没过 | 每个读都带 `acceptance`；命令和每条的输出在 `get_worker_result.acceptance.checks` |
| worker 吃了哪些上下文 | `get_context_snapshot_meta`，只看 fact IDs/token/排除项，不会回 capsule 正文 |
| 一条共享事实的来源 | `get_fact`，按 ID 精确读；不要把一批 facts 全拉进主线程 |

默认读回来的长文本都是裁过的（`current_action` 300 字、`prompt` 300 字、`last_message` 400 字），别把裁剪当成活没干。全量在库里。别一次 `limit: 200` 拉全量事件。

worker 的 capsule 只在内部 create/resume 时生成：自身 L0 身份、当前 work 的 verified facts、显式 `dependsOn` 的摘要、路径命中且 SHA 有效的 repo facts。`session_id` peers、raw event、完整 diff/报告、candidate facts 一律不自动注入。主线程只能看 snapshot 元数据；要查证据按 ID 读，不能把自己变成 worker。

worker 最终 JSON 只是 `candidate`：先留在本 run 做审计，绝不因为它自己说“完成”就变共享事实。supervisor acceptance 通过才会派生当前 work 的 `verified` outcome；验收失败/未配置、脏 diff、未 land/push 都不是 verified 交付证据。

## 断了怎么接

| 情况 | 用什么 |
|---|---|
| 主线程自己挂了 | 独立运行进程继续记日志、状态和验收；新窗口 `get_session_works({ session_id })` 收回同批活 |
| worker 变 `lost`（worker 或独立运行进程中断） | `resume_codex_worker`。worktree 里的改动和 `thread_id` 都在，同一线程接着干；被杀时正在做的那一步可能要重做 |
| worktree 落后主线（`base_behind.behind > 0`） | `resume_codex_worker` 带 `rebaseOnto: "HEAD"`，见收活第 4 步 |
| worker `failed` | 看 `error` 和日志，查完再 resume 或重派 |
| 没记到 `thread_id` 的老行 | `create_codex_followup_worker`，新线程靠文本重述 |

`status` 是生命周期：`queued` / `running` / `completed` / `failed` / `cancelled` / `lost`。`phase` 只在跑着时有值：`starting` → `thinking` → `command` → `editing` → `reporting`。`completed` 配 `exit_code: null` 是中间态，`wait` 会等到退出码落了再返回。goal 的 `paused` / `blocked` 不是结束，是等人管，overview 会列进 `needs_attention`。

## 看到 `update` 字段就转告用户

overview、派单回执、`wait` 返回里出现 `update` 且 `update_available: true` 时，当轮回复里照 `notice` 告诉用户一句。`auto_update.state` 是 `started` / `running` / `done` 时新版已在后台装，重开会话即可；`install_command` 有值才让用户自己跑。只说一次。

## 常见坑

- worktree 从一个提交切，你工作区里没 commit 的东西 worker 看不到。要让它读到就给绝对路径或先 commit；Git worktree 建不出来会明确拒绝，不会退回主目录执行。
- `exit_code: 0` 只说明没崩。`acceptance` 是 supervisor 替你跑的验收，`verification` 是它自己跑过的，两个都没有就只剩 diff。验收命令别往 worktree 写文件，会混进它的改动。
- `ownedPaths` 在跨MCP派单/恢复时原子预留，验收和退出结算前仍占用；Git隔离创建失败不退回主目录。land 按真实 diff 拒越界（提交草稿前就查）。仍不等于运行时沙箱，收活看 diff；`allowOutsideOwned` 只用于用户明确批准的例外。
- worktree 只隔离工作区，端口和数据库是共用的。
- `resume_codex_worker` 不会再建 goal。`cancel_codex_worker` 跨进程靠 pid，要求那个 pid 的命令行里带 `codex`。

收尾先 `cleanup_plan` 看 SAFE / REVIEW / BLOCKED；只有 push_verified、干净、无活跃依赖且 fingerprint 未变化的 SAFE item 才可 `apply_cleanup`。CLI 对应 `npm run cleanup -- --dry-run` / `--apply`。branch、task、event、JSONL、artifact 保留；脏、未合、未 push、lost/failed和证明不了的一律不删。

## 看板

用户想用眼睛看就让他起 `codex-supervisor-web`（或 `npx -p codex-supervisor-mcp codex-supervisor-web`），开 `http://127.0.0.1:7877`。按 session 分组，每路有「旁问」tab，用户可以自己问 worker。

安装后没工具：先查Claude/Codex的mcp get codex-supervisor；运行codex-supervisor-setup修复本包旧入口，手动失败非0，skill写入失败仍尝试注册。CLI不在PATH设CLAUDE_BIN/CODEX_BIN；skill跟随CLAUDE_CONFIG_DIR/CODEX_HOME。禁用安装脚本时不会自动注册，自定义/disabled/project配置保留并提示处理；重开会话加载新工具和skill。
