# 参考手册

[README](../README.md) 只讲怎么上手。每个工具的入参、守卫和验收的边界、沙箱放开了哪些目录、全部环境变量，都在这里。

## 工具

默认 14 个，另有 3 个设 `AGENT_SUPERVISOR_TOOLS=all` 才注册。参数全是 snake_case；多传或拼错的参数会被拒绝，不会被忽略。失败的调用带 MCP 的 `isError` 和一个稳定的 `error` 码。

| 工具 | 入参 | 作用 |
|---|---|---|
| `preflight_worker` | `cwd`, `probe_commands`, `acceptance`, `owned_paths`, `title`, `model`, `reasoning_effort`, `workspace`, `sandbox`, `context`, `limits` | 带 `probe_commands`：用和目标 worker 相同的 workspace、sandbox、守卫起一个短 probe，返回它的 id。只带 `acceptance`：立刻在 `cwd` 里跑这些验收命令并返回结果，不建 worker |
| `create_worker` | `task`, `cwd`, **`owned_paths`**, **`goal`**, `title`, `followup_of`, `depends_on`, `preflight_id`, `model`, `reasoning_effort`, `session`, `workspace`, `sandbox`, `context`, `acceptance`, `limits` | 派一路。带 `followup_of` 时从那路的分支接着干，没给的参数沿用它的，此时 `cwd`、`owned_paths`、`goal` 可省 |
| `resume_worker` | `task_id`, `prompt`, `rebase_onto`, `context_files`, `acceptance` | 接同一个会话继续跑。`rebase_onto` 先把 worktree 挪到新的提交上，冲突原样退回、不起 worker |
| `cancel_worker` | `task_id` | 终止 worker 或它正在跑的验收。worktree 和已有改动保留 |
| `poll_workers` | `cursor`, `status`, `limit` | 不带 `cursor`：全部 worker 的状态表（封顶 7000 字节）加一个 `next_cursor`，只读。带 `cursor`：只返回这之后的变化，并顺带恢复一次已死的第一轮、清掉可清的 worktree |
| `wait_workers` | `task_ids`, `mode`, `timeout_ms`, `allow_long_wait`, `emit_progress`, `compact`, `include_events`, `event_limit`, `poll_ms` | 等到结算，单次最多 60 秒。返回 `timeout_capped` 和 `termination_reason` |
| `get_worker` | `task_id`, `include`, `max_chars`, `event_limit`, `event_kinds`, `result_limit`, `include_files` | 读一个 worker。`include` 可选 `status` / `result` / `goal` / `events` / `evidence` / `context` / `preflight` / `prompt`；不给就是一段话摘要，给一项返回那一项，给多项按项分组 |
| `get_worker_diff` | `task_id`, `file`, `hunk`, `page_size`, `cursor`, `max_chars`, `paths` | worker 实际改了什么。默认文件索引和 hunk 数，按 `file` + `hunk` / `cursor` 分页读 patch |
| `ask_worker` | `task_id`, `question`, `timeout_ms`, `max_chars`, `fresh`, `end` | 旁路问一句。线程 fork 成只读会话，没网络、没 MCP 工具，worker 本身不动 |
| `land_worker` | `task_id`, `commit_message`, `onto`, `include_followup_parents`, `commit_messages`, `ignore_acceptance`, `allow_outside_owned` | 把 worker 的提交 cherry-pick 到派单目录的当前分支。`commit_message` 先替它把未提交改动提交成一笔 |
| `verify_push` | `task_id`, `remote`, `branch` | fetch 远端分支并证明合入的提交已可达。只验证，不 push |
| `cleanup` | `action`, `task_ids`, `project_root`, `plan_id`, `item_ids`, `limit` | `plan`：每个 worktree 的判定和原因；`apply`：立刻清掉选中的 SAFE 项；`history`：清理记录 |
| `find_works` | `session_id`, `query`, `limit` | 一个 session 的全部 worker，或在标题、目标、prompt、最后消息里找子串 |
| `describe_session` | `session_id`, `title`, `note`, `objective`, `default_acceptance`, `approval_state`, `expected_revision` | 给一批活记标题、目标、默认验收和审批状态 |
| `facts`（按需） | `action`, `task_id`, `fact_id`, `query`, `limit`, `cursor`, `scope`, `watched_paths`, `expires_at`, `reason` | `search` / `get` 查已验证的事实；`promote` 把候选升为已验证；`revoke` 撤销 |
| `review`（按需） | `action`, `task_id`, `verifier_task_id`, `title`, `verdict`, `reason`, `resolution` | `start` 起一个只读、断网的 verifier；`record` / `resolve` / `get` 记结论、记收口、查记录 |
| `get_artifact`（按需） | `artifact_id`, `max_chars` | 读一份留存的证据 |

分组参数：

| 组 | 字段 |
|---|---|
| `workspace` | `kind`（`git_worktree` 默认 / `read_only_in_place` / `scratch` / `in_place_write`）、`base_ref`、`setup`（`links`、`submodules`、`commands`）、`in_place_authorization`、`skip_git_repo_check`、`external_outputs` |
| `sandbox` | `mode`（`workspace-write` 默认 / `read-only` / `danger-full-access`）、`network_access`、`writable_roots`、`allowed_commands`、`forbid` |
| `context` | `files`（`[{path, sha256?}]`，最多 20 份）、`contracts` |
| `acceptance` | `commands`（字符串，或字符串与 `{command, report_path, baseline}` 的列表）、`timeout_ms` |
| `limits` | `max_run_ms`、`max_total_ms` |
| `session` | `id`、`title`、`note` |
| `goal` | `objective`、`token_budget` |

不带 `followup_of` 时 `cwd`、`owned_paths`、`goal.objective` 必填。写 worker 还必须通过 preflight：先用同一套参数跑带 `probe_commands` 的 `preflight_worker`，通过后把它的 id 填进 `preflight_id`。`owned_paths` 的写冲突在派单时预留，运行时 guard 会查直接写入，land 会再查完整 diff。

`acceptance` 在 Bash 中启用 `errexit` 和 `pipefail`：未处理的失败会停止检查，`npm test | tail` 中的测试失败也会保留。worker 自查必须运行 `node "$AGENT_SUPERVISOR_ACCEPTANCE_CLI"`，它只读 supervisor 状态库中的验收契约，不需要写数据目录；不要手抄到 zsh，变量拆词等交互壳差异不会污染证据。写 worker 不能只用 `test -s`、`test -f` 或 `[ -e ]` 这类文件存在性命令交付；要加真实 test、endpoint probe 或结构化执行证据。识别到的 test runner 输出 `no tests to run` / `[no test files]` 时，即使退出码是 0 也判失败。预期失败用 `if` 或 `||` 显式处理；超时始终判失败，即使命令收到终止信号后退出 0。Windows 需要 Git for Windows 的 Bash；找不到会报错。显示的输出会裁剪，退出码不会因此改变。

`package.json` 仓库里，如果 `acceptance` 使用 `npm`、`pnpm`、`vitest`、`vue-tsc`、`eslint`、`nuxi` 等本地 JavaScript 工具，而派单没有 `workspace.setup`，会直接拒绝为 `workspace_setup_required`。这条是 runtime 硬门禁，不再靠模型记得手工链接依赖。

前端 worktree 的标准配置：

```json
{
  "workspace.setup": {
    "links": [{ "path": "node_modules", "source": "node_modules" }],
    "submodules": true,
    "commands": ["npx nuxi prepare"]
  }
}
```

同一份配置要同时传给 `preflight_worker` 和目标 `create_worker`，否则 runtime contract 不匹配。

`workspace.setup.links.source` 按派单的 `cwd` 解析，也可以直接写绝对路径；`path` 始终是 worktree 内的相对目标。源目录必须先存在。

带 `followup_of` 的 `create_worker` 在父任务未 land 时继承其 `worker/<parent>` 分支的当前提交，父任务已 land 则从当前集成分支 HEAD 开始；显式 `workspace.base_ref` 优先。父 worktree 里没提交的改动仍只属于父任务，父 checkpoint 丢失时返回 `followup_checkpoint_missing`。需要整条接续链落地时调用 `land_worker({include_followup_parents: true})`，主线程先审各路 acceptance 和 diff，工具再按 root-first 落地；途中失败保留此前已落地的结果，修复后可重复调用。

worker 和 run host 都已退出时，当前 run 的 durable `turn.completed` 可以恢复 `completed` 和退出结算，独立保留 acceptance 的通过、失败或中断状态。缺失验收结果标记为 interrupted，仍需重新验收后才能 land；恢复不会删除 worktree 或自动重跑 worker。

链式 landing 会跳过已证明在目标分支上的提交和零改动祖先；`ignore_acceptance` / `allow_outside_owned` 只作用于指定的 leaf，不自动扩大到祖先。

普通 worker 启动时会关闭它继承到的 `codex-supervisor` MCP，不能再派 worker、resume、cancel 或改编排状态；主线程是唯一编排者。其他业务 MCP 不受影响；旁问 fork 仍关闭全部 MCP，因为它只允许只读回答。

`session.id` 只负责批次、默认门禁和审批，不再把同批 worker 的标题、汇报或 session objective 自动塞进新 worker。worker 只收到内部编译的 context capsule：L0 只标明 branch 与 acceptance 来源（不塞命令正文）、自身身份/任务、显式依赖的最小交付摘要和路径/SHA 命中的 verified facts；raw event、完整 diff、历史报告、candidate facts 都只可按需读取。repo fact 只有两个 checkout 的 canonical `origin`、repo-relative watched path 和 base SHA 同时匹配时才跨 checkout 可见；无可识别 origin 就保持 work-scoped。事实的 base SHA 不再覆盖、watched path 发生 Git diff、context 输入内容 hash 或非 Git in-place manifest 漂移时会自动追加 `expired` 版本并从 capsule 排除。主线程只看 `get_worker`，需要证据时再显式 `facts` / `get_worker` / `get_worker_diff`。

worker 的最终 JSON 报告会先记录为该 run 的 `candidate` fact，不能跨 work 自动注入；supervisor acceptance 通过后才生成当前 work 的 `verified` outcome，并带 report/acceptance event 来源、base SHA 与 watched paths。schema-free resume 的纯文本报告只保留为 candidate，不把合成的空数组当作已验证事实。push proof 另存为 retained artifact，verified fact 可回指该 artifact。验收失败、未配置验收或 worker 自报完成都不会升级成共享真相。

交付状态分开：acceptance 通过只是 `verified`，`land_worker` 只是 `landed`，仍不代表远端有这笔提交。需要显式 `verify_push` fetch 并校验 `landed_head` 已在目标 remote branch 上，才是 `push_verified`；该工具绝不代替用户执行 push 或部署。清理不依赖它：合入就够了。

worker 进程和 supervisor 验收子进程都包含当前 `AGENT_SUPERVISOR_TASK_ID`、`AGENT_SUPERVISOR_BASE_COMMIT` 和 `AGENT_SUPERVISOR_RUN`；分别是当前任务、运行基线和次数，rebase/resume 后两边一起更新。

结构化验收项用 `{command, report_path, baseline}`。baseline 包含 `identity.base_commit`、`failures`（test_id/kind/signature）和 `required`；报告包含 complete、identity、failures、executed、skipped，以及本次 `AGENT_SUPERVISOR_CHECK_ID`。必跑用例缺失/跳过、旧报告、失败名单变化都拒绝通过，原始退出码保留。report_path 必须在工作目录内；测试报告可能写文件，要用忽略的临时目录，避免把报告合入。

落地前按真实 diff 核对 owned_paths，越界拒绝且不提交草稿；只有用户明确授权时才用 allow_outside_owned。

worker 的 acceptance 在代提交之前执行，应检查功能和测试；`test -z "$(git status --porcelain)"`、提交数量和提交信息检查由主线程放到 land 后执行。验收失败先核对当前 run 的具体失败项，不能仅因报告更新、外部测试通过或主线程补过提交就视旧失败为已解决；契约冲突交规划/集成负责人修订并重新验收，不手工 cherry-pick 绕过。

同 session 的 `default_acceptance` 自动加到每路本地检查前；resume 会取最新策略。`describe_session` 返回 policy_revision，改目标/门禁可传 expected_revision 防旧窗口覆盖；waiting_user 拒绝派单与恢复，approved 后再继续。回执host_goal_sync包含按当前策略生成的/goal命令；宿主已有原生goal时用/goal替换条件，支持ProposeGoal时可提议同一条件并走宿主批准。条件要求读取最新session revision及批准范围；MCP不会偷偷修改或禁用宿主Stop hook。

wait 默认预算60秒、默认compact，过长请求也限制为60秒，返回 `requested_timeout_ms` / `timeout_ms` / `timeout_capped`。确认客户端允许长调用后可显式 `allow_long_wait: true`；`emit_progress` 只在请求且客户端传 progress token 时通知，不能延长宿主的硬超时。已有后台 wait 就接回它，不重复开长 wait；长期监控用宿主定时调用 `poll_workers`。

每路临时注入随包PreToolUse守卫：apply_patch核对全部目标路径（含rename和symlink），forbid拒绝红线；安全只读检查（rg/cat/sed无-i/git只读/jq无-i/find无-exec或-delete）默认允许且不占其他 worker 的写路径，写入/执行/有副作用的 Shell 命令必须显式声明。声明的验证脚本以派单者权限执行，可有副作用，不能当作任意程序的文件沙箱。guard策略随resume/followup继承，不写全局hooks。空跑write run按本轮输出前后内容和命令判断，no_work进入needs_attention；只读任务不因没改文件判空跑。

守卫同时拦截 `create_goal` 的预算：派单未传 `goal.token_budget` 时，worker 必须完全省略 `token_budget`；模型自行填写 `0`、`1` 或 `null` 会被拒绝，不会被误当成“不限预算”。显式传预算时只允许逐值一致，缺失或改动都拒绝。原生 goal 仍用于完成状态与 token 用量统计。

没有独立 `apply_patch` 工具的模型（实测 Codex 0.162 + DeepSeek/cc-switch）把补丁当 shell 命令发过来：`apply_patch <<'EOF' ... EOF`。守卫认这个形状，用同一套 owned_paths 规则判每个目标路径，所以这种模型也能改文件；未加引号的 heredoc、后面还接 `&&`/`;` 的都拒绝。

`sandbox.allowed_commands` 里以 `*` 结尾的条目是前缀匹配（如 `go test ./internal/*` 覆盖 `go test ./internal/service -run TestX`），只对没有 shell 元字符的单条命令生效。编辑器 worker 的只读白名单覆盖 grep/sed（无 `-i`）/find（无 `-exec`/`-delete`）/jq（无 `-i`）/awk、git 只读子命令和 `cmd | head|tail|wc|sort|uniq` 纯读管道；`tee`、重定向、`env` 仍拒。守卫不是文件沙箱，漏网的写入只会落在 worker 自己的 worktree，land 会拒。

守卫按 worker 形状放权：`git_worktree` 编辑 worker 只放声明过的命令和简单读取；`read_only_in_place` 无写入无网络；`scratch` 的联网草稿只能写在 `SUPERVISOR_HOME/scratch/<taskId>`；`in_place_write` 必须有显式授权、owned_paths 与 acceptance，并保存前后 manifest。非 Git `workspace-write` 没写 `workspace.kind` 会拒绝，绝不默认写用户目录。

带 cursor 的 poll_workers 在状态协调后，对已结束的第1轮lost/no_work/invalid_report原子resume一次（invalid_report只要求重发裸JSON，不重做活）。如果当前 run 已经持久化 `turn.completed`，只是 run host 没落 exit code，supervisor 会从 durable event 恢复为 completed 并保留 report/attention 证据，不再误标 lost。两轮同 fingerprint 的无输出/无命令会升级为 `two_stall` 和 `needs_attention`，不再自动重试；审批、认证、权限和quota等待也不重试，返回recoveries记录。worker最终输出要求JSON result/verification/not_done；解析只做安全修复：字符串字段归一成 string[]，以及唯一缺少的 `]`/`}`，伪造字段仍拒绝。报告只是摘要；invalid_report 保持 `completed` 生命周期和 attention，不否定同 run acceptance 和真实 diff，显式 land 仍可用；旧历史标legacy_text。

context用绝对文件路径与可选sha256声明材料，最多20份、与contracts合计6000字；文件不超过5 MB。首次派单记录实际哈希，resume校验原材料未变，需要新材料时显式传context。handoff最多1800字/16行，截断明确标记；完整约束和引用单独保留，材料不授予写权限。

确需共享写入时声明workspace.external_outputs:[{path,sha256?}]并配置acceptance。目标必须是绝对文件路径、每份≤1 MB；记录本轮前后哈希和有界内容，result/diff标shared_file_already_written_not_cherry_pick，不能通过land合入外部文件。外部目标参与归属冲突与hook；验证脚本的共享副作用由派单者负责。

workspace-write默认sandbox.network_access:false；需要ssh/联网验证显式true，随resume/followup继承，不以danger-full-access代替。limits.max_run_ms限制单轮、limits.max_total_ms限制从派单开始的总时长；超限中止worker并保留needs_attention/partial work，不自动重试。wait预算不改变这些quota。

沙箱除工作区和临时目录外，自动放开 OS cache 目录（macOS `~/Library/Caches`、Linux `~/.cache`、Windows `%LOCALAPPDATA%`）、home 下已存在的工具链缓存目录（`.cargo`/`.npm`/`.yarn`/`.pnpm-store`/`.bun`/`.m2`/`.gradle`/`.nuget`/`.ivy2`/`.bundle`/`.composer`/`.pub-cache`/`.mix`/`.hex`/`.stack`/`.cpanm`/`.deno`/`.conda`、`go/pkg`）。Go build cache（平台默认 `go-build` 或显式 `GOCACHE`）单独 realpath 并放行真实目录，因此 symlink 指向外置盘时也可在 worker sandbox 使用；**凭据目录一律不自动放开**（`.ssh`/`.gnupg`/`.config`/`.aws`/`.docker`/`.kube`/`.netrc`/`.git-credentials`/`~/Library/Keychains`）：ssh 连服务器要写 known_hosts、kubectl、推私有镜像、签名提交这类需求，派单时显式传 `sandbox.writable_roots`，只在这一路生效。`SUPERVISOR_NO_AUTO_CACHE_ROOTS=1` 关掉全部自动缓存根，显式声明的照常生效。Codex 拒绝带软链的可写根，所以自动 cache 和 `sandbox.writable_roots` 都先按 realpath 解析；解析不出无软链路径的根直接不传。其他 cache 放在别处（`~/.m2`、`~/.gradle`、vendor 镜像）就传 `sandbox.writable_roots:[绝对路径]`，要求是已存在目录、最多 20 个、只对 workspace-write 生效、随 resume/followup 继承；只读复用就不用传。

运行前核验Codex CLI是否具备hooks/output-schema（要求0.162+）；能力不足返回start_failed，wait可正常结算。get_worker.native_goal_read区分missing_goal、missing_database、locked和read_error，不能把读取失败当没建goal。原生budget/usage限制也进入needs_attention。

owned_paths 预留和任务入库在同一事务内，跨MCP并发派单/恢复不能抢同一输出；验收或退出尚未结算时仍保留归属。Git工作区隔离创建失败明确报错，不退回主目录执行；非 Git `scratch` 也不落回原目录。

清理默认自动进行：带 `cursor` 的 `poll_workers` 每 10 分钟最多顺带扫一次，把 SAFE 的 worktree 删掉，并在返回里用 `cleaned` 列出。判定规则：

| 情况 | 判定 |
|---|---|
| worker 或验收还在跑，或有活跃 worker 依赖它 | BLOCKED |
| 已合入且提交仍在目标分支上，工作区干净 | SAFE |
| 结束了但没有任何改动（失败、取消、超时、空跑） | SAFE |
| 有未合入的提交或未提交的改动 | 保留期内 REVIEW，到期后 SAFE |
| 路径、分支或 Git 注册对不上 | REVIEW，不自动处理 |

保留期默认 7 天，从 worker 结束算起，用 `AGENT_SUPERVISOR_CLEANUP_HOLD_DAYS` 改。到期删除前，未提交的改动会先存成一笔提交放到 `worker/<id>` 分支上，`workspace.setup` 链进来的路径和被 gitignore 的构建产物不算改动、不保存。分支、task、事件、JSONL、artifact 永远保留。

worktree 被清掉后，`resume_worker`、`land_worker`、`ask_worker`、`get_worker_diff` 会从分支把它重新切出来，`workspace.setup` 也会重做，所以清理不会让没做完的活接不回来。

手动入口：`cleanup` 看判定和原因，`cleanup` 立刻清 SAFE 项；命令行是 `codex-supervisor-cleanup --dry-run` 和 `codex-supervisor-cleanup --apply --plan <plan_id> --item <item_id>`。`AGENT_SUPERVISOR_NO_AUTO_CLEANUP=1` 关掉自动清理，只留手动。研究型 worker 的 scratch 目录按同一个保留期清。

## 看板里有什么

| 位置 | 内容 |
|---|---|
| 左栏 | 每个 session 一行：标题、worker 数、几路在跑、最近活动。左下角是版本和更新提示 |
| session 页 | 统计（总数 / 运行中 / 完成 / 失败 / 丢失），有 worker 在跑时列每路正在执行的命令 |
| worker 台账 | 一行一路：状态、标题、正在跑的命令或最后一句汇报、耗时、改了几个文件、跑了几条命令 |
| worker 抽屉 | 七个 tab：概览、汇报、改动、命令、事件、任务书、旁问 |
| 旁问 | 对这路 worker 提问，就是 Codex 的 `/btw`：从它的线程 fork 出只读旁路会话来答，不碰它正在跑的活。多轮、可中断、换标签页回来自动接上 |

浅色深色跟系统走，没有外网资源。

长门禁脚本可以主动上报阶段：

```bash
node "$AGENT_SUPERVISOR_STAGE_CLI" "gate:s3" --detail "integration queue"
```

`current_stage` 会出现在 status / overview / wait，终态保留为 `last_stage`；不要放 token、密码或 DSN。

## 状态机

| `status` | 含义 |
|---|---|
| `queued` | 已派单，未启动 |
| `running` | 运行中。`phase`：`starting → thinking → command → editing → reporting` |
| `completed` | 成功 |
| `failed` | 非零退出码、`turn.failed`、spawn 失败。`failure.source` / `failure.code` / `failure.retryable` 给出原因；进程非零退出时按 stderr 归到 `auth`、`provider`、`runner_config` 或 `worker_process`，`failure.detail` 是 stderr 最后一行 |
| `cancelled` | 被 `cancel_worker` 中断 |
| `lost` | worker 被外部信号杀掉、运行进程失踪、或者行写了但进程从没起来。`resume_worker` 接回 |
| `timed_out` | `limits.max_run_ms` 或 `limits.max_total_ms` 用完，supervisor 主动停掉。不会自动重试。单轮超时可以 `resume_worker`（每轮重新计时）；总预算用完只能用 `create_worker` 的 `followup_of` 带新 `limits` 接续 |

终态分两步落盘：`turn.completed` 先把 status 置成 completed，进程退出后才写 `exit_code`；`wait_workers` 等到 `exit_code` 落了才返回。Windows 没有信号，外部 kill 只报 `failed` 加退出码。Codex 原生 goal 的 `paused` / `blocked` 算 `running` 并进 `needs_attention`，`usageLimited` / `budgetLimited` 算 `failed`。

## 状态存储

默认在 `~/.codex-supervisor/`：

| 文件 | 内容 |
|---|---|
| `data/supervisor.sqlite` | `tasks`（一行一个 work）、`task_events`、`sessions`、`side_sessions` / `side_turns`（旁问） |
| `data/crash.log` | MCP 进程、run host、看板的未捕获异常，一行一条 JSON。工具突然全部 `Connection closed` 时先看这里 |
| `data/runs/<taskId>.jsonl` | Codex `--json` 的原始输出。超过 2KB 的事件（主要是命令输出）全文只在这里，`task_events` 里是截断摘要；`get_worker` 读 `events` 不带 `max_chars` 时从这里取回全文，文件没了就返回摘要并标 `supervisor_clipped.missing` |
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
| `AGENT_SUPERVISOR_NO_UPDATE_CHECK` | 未设 | `1` 关闭更新检查 |
| `AGENT_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD` | `300000` | native goal 累计 token 达到该值时 status/overview 标记 `handoff_recommended`；设 `0` 关闭 |
| `AGENT_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | 更新检查和自动更新用的 registry |
| `AGENT_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | 等 registry 的上限 |
| `AGENT_SUPERVISOR_NO_AUTO_UPDATE` | 未设 | `1` 关闭后台自动更新（只提醒） |
| `AGENT_SUPERVISOR_NO_AUTO_CLEANUP` | 未设 | `1` 关闭 worktree 自动清理，只能手动 `cleanup` |
| `AGENT_SUPERVISOR_CLEANUP_HOLD_DAYS` | `7` | 未合入的活结束后保留几天再清；`0` 表示不保留 |
| `AGENT_SUPERVISOR_SKIP_SKILL_SYNC` | 未设 | `1` 关闭 server 启动时的 skill 同步 |
| `AGENT_SUPERVISOR_SKIP_SETUP` | 未设 | `1` 跳过 `postinstall` 的自动安装 |
| `AGENT_SUPERVISOR_NPM` | 未设 | 自动更新用的 npm，默认用当前 node 自带的 |

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

## Windows

- npm 装的 CLI 是 `codex.cmd`，Node 拒绝直接 spawn 它。这里绕到 `node_modules/@openai/codex/bin/codex.js` 用 `node` 起，不用 `shell: true`，那样取消时只杀得掉 shell。
- 跨进程取消用 `taskkill /PID <pid> /T /F` 杀整棵树，先确认那个 pid 跑的是 codex。
- 除 `PATH` 外还探 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`%LOCALAPPDATA%\Volta\bin`、`%ProgramFiles%\nodejs`。
