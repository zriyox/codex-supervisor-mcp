---
name: codex-supervisor
description: 用 Codex CLI 并行做可独立验收的功能包，每路一个 Git worktree，能派单、等待、验收、恢复、合入和清理。用户说“派 codex”“并行跑”“多 agent”“接回旧 worker”时使用。
---

# codex-supervisor

主线程负责拆包、定写集、准备环境、验收和合入。worker 只在自己的 worktree 里完成一个功能包，不负责编排，也不负责交付到远端。

## 什么时候用

适合能拆成几路、每路能单独验收的活，也适合耗时长、中途可能断、需要保留证据的工作。纯问答、单文件小改、需要频繁来回确认的活，主线程自己做更快。

## 14 个工具

| 阶段 | 工具 |
|---|---|
| 派单前 | `preflight_worker` |
| 派单 | `create_worker`、`resume_worker`、`cancel_worker` |
| 盯进度 | `poll_workers`、`wait_workers` |
| 收活 | `get_worker`、`get_worker_diff`、`ask_worker` |
| 交付 | `land_worker`、`verify_push`、`cleanup` |
| 批次 | `find_works`、`describe_session` |

参数全是 snake_case，写错名字会被直接拒绝，不会被悄悄忽略。失败的调用带 `isError` 和一个稳定的 `error` 码。`facts`、`review`、`get_artifact` 默认不开，要用时让用户设 `AGENT_SUPERVISOR_TOOLS=all`。

## 派单前必须确认

1. 先 `find_works`，确认没有重复派工。
2. 按功能闭环拆包，不按 DTO、方法或单个测试拆。每路要有清楚的输入、产出和 acceptance。
3. `owned_paths` 要覆盖完整写集：实现、测试、路由、注册表、DI、配置、迁移、i18n、模板接线都算。拿不准就给唯一模块目录。
4. 依赖必须提前放进 worktree，用 `workspace.setup`。前端链接 `node_modules` 并执行 `nuxi prepare`；后端初始化 submodule。不要等主线程事后补。
5. 写 worker 先用同一套参数跑 `preflight_worker`（带 `probe_commands`）。`get_worker` 的 `include: ["preflight"]` 必须是 `passed`，再把那个 task id 填进 `preflight_id`。只给 `acceptance` 的 preflight 只是试跑验收命令，不能代替环境预检。
6. 只要 worker 会 land，就必须有能证明结果的 acceptance。文件存在检查只能当附加条件。
7. `workspace-write` worker 不执行 `git add`、`git commit` 或 `amend`。验收通过后由主线程 `land_worker` 带 `commit_message` 代提交并落地。Git 干净、提交数量和提交信息由主线程在 land 后检查。
8. worker 不 push、不合并、不再派生 worker。`worker/<id>` 分支不是交付物。

## create_worker 的参数

顶层：`task`、`cwd`、`owned_paths`、`goal`、`title`、`followup_of`、`depends_on`、`preflight_id`、`model`、`reasoning_effort`。其余按组放进对象：

```json
{
  "task": "背景、文档出处、完整写集、验证命令、输出格式",
  "cwd": "/repo",
  "owned_paths": ["src/feature", "test/feature"],
  "goal": { "objective": "一句话说清做完是什么样" },
  "session": { "id": "batch-1", "title": "补单测" },
  "workspace": {
    "setup": {
      "links": [{ "path": "node_modules", "source": "node_modules" }],
      "submodules": true,
      "commands": ["npx nuxi prepare"]
    }
  },
  "sandbox": { "allowed_commands": ["pnpm vitest run test/feature/*"] },
  "acceptance": { "commands": ["pnpm vitest run test/feature"] }
}
```

| 参数 | 怎么填 |
|---|---|
| `task` | 写清目标、背景、要改的交付面、边界和验收。最终报告格式由 supervisor 追加，不在这里重复 |
| `owned_paths` | 完整写入范围；不同 worker 不能重叠，读取不排他。`[]` 只用于不 land 的只读或研究 worker |
| `goal.objective` | worker 会创建 Codex 原生 goal。`goal.token_budget` 不传就是不限；别传 `0`、`1` 或 `null` |
| `session.id` | 同一批用同一个值。只负责分组、默认验收和审批，不会把同批 worker 的上下文互相注入 |
| `workspace.kind` | Git 代码默认 `git_worktree`；非 Git 只读用 `read_only_in_place`；联网研究用 `scratch`；明确授权才用 `in_place_write` |
| `workspace.base_ref` | worktree 从哪个提交切。要包含上一步时填上一路的 `worker/<task_id>` 或已集成分支 |
| `workspace.setup` | `links.source` 按 `cwd` 解析，也可写绝对路径。验收用了 npm、pnpm、vitest、eslint、nuxi 这类本地工具却没给 setup，会直接返回 `workspace_setup_required` |
| `sandbox.mode` | 默认 `workspace-write`。这个沙箱不能 commit，是正常边界；不要为了提交改用 `danger-full-access` |
| `sandbox.allowed_commands` | 会执行、会写入或有副作用的验证命令。只读命令有白名单；末尾 `*` 表示前缀匹配 |
| `sandbox.forbid` | 明确禁止的命令片段，优先于 allowed_commands 和 acceptance |
| `acceptance.commands` | worker 退出后由 supervisor 在 worktree 里执行，全部退出 0 才算过。worker 自查统一跑 `node "$AGENT_SUPERVISOR_ACCEPTANCE_CLI"`，不要手抄命令 |
| `depends_on` | 上游 task id。上游必须已结算、验收通过并 land，且本路 base 包含它 |
| `followup_of` | 接着一路已结束的 worker 干：从它的分支切新 worktree，没给的参数沿用它的 |
| `preflight_id` | 写 worker 必填。base、workspace、sandbox、owned_paths、context 有任何变化都要重跑 preflight |

回执不回传 task 原文，带 `id`、`worktree_path`、`branch`、`owned_paths`、`status`。

| worker 形状 | 参数 | 用途 |
|---|---|---|
| Git 编辑 | 默认 workspace，非空 `owned_paths` | 改代码、跑 acceptance、等主线程 land |
| 只读验收 | `workspace.kind: "read_only_in_place"`、`sandbox.mode: "read-only"`、`owned_paths: []` | 无写入、无网络，只给结论 |
| 联网研究 | `workspace.kind: "scratch"`、`sandbox.network_access: true`、`owned_paths: []` | 可以 curl/gh，只写 scratch，永不 land |
| 非 Git 写入 | `workspace.kind: "in_place_write"`、`workspace.in_place_authorization`、acceptance | 只改明确授权的非 Git 目录 |

## 等待与状态

- `poll_workers` 不带 `cursor` 返回全表和一个 `next_cursor`，只读，不启动任何东西。
- 带上那个 `cursor` 再调，只返回这之后的变化：`transitions` 里是结束、失败或需要关注的 worker 和下一步；`quiet: true` 表示没事发生。带 cursor 的调用还会顺带做两件事：把已死的第一轮恢复一次，把可以清的 worktree 清掉。
- 长任务用宿主 `/loop 5m` 调带 cursor 的 `poll_workers`。cursor 存在状态库里，主线程重启后接着用。
- 短等用 `wait_workers`，一次最多 60 秒；`timeout_capped` 表示请求被限成短等，`still_running` 只表示预算用完。确认宿主允许长调用才传 `allow_long_wait: true`。
- `idle_seconds` 是距上一条事件的时间。`command_running: true` 时长命令可能还在跑；没有命令又长时间无事件，再用 `get_worker` 的 `include: ["events"]` 查。
- 活跃线程超过交接阈值时每个 run 提醒一次；先看状态，等当前步骤结算或明确取消后再用 `followup_of` 接续，不要因为 token 多就重复起同一个任务。
- 不要用 shell 循环 grep `data/runs/*.jsonl` 判断状态，以 supervisor 状态机为准。

## 收活顺序

1. `get_worker` 的 `include: ["result"]`：先看 `acceptance`，再看它真跑过的命令和退出码。失败时把 `checks[].output_tail` 原样带回 resume，不改验收标准。
2. `get_worker_diff`：先看文件和 hunk 索引，再按 `file` + `hunk` / `cursor` 分页读 patch。它说做了什么不算，diff 里有才算。
3. 对不上就 `ask_worker`。旁路只读，不改 worker 线程。
4. 要改就 `resume_worker`。主线前进时带 `rebase_onto: "HEAD"`。原生 goal 未明确 complete 时，续跑会省略 output schema，避免 `ActiveTurnOutputSchemaMismatch`。
5. 验收和 diff 都过了，`land_worker` 带 `commit_message`。

接续链：整条链先审各路 acceptance 和 diff，再 `land_worker` 带 `include_followup_parents: true` 和 `commit_messages`，按 root-first 落地；途中失败保留已落地部分，修复后重调。`ignore_acceptance`、`allow_outside_owned` 只对指定的那一路生效，只在用户明说时用。

`invalid_report` 不是业务失败，通常是报告 JSON 不合规。带 cursor 的 `poll_workers` 会自动让它重发一次；仍失败时，acceptance 通过且 diff 审过，可以直接 land。报告只是摘要，不是交付证据。

## 中断与恢复

| 情况 | 处理 |
|---|---|
| 主线程挂了 | worker 的独立进程会继续记录日志、状态和验收。新窗口用 `find_works` 按 session 接回 |
| worker 变 `lost` | 确实中断才 `resume_worker`；worktree、改动和线程都保留 |
| worker 变 `timed_out` | 时间预算用完被停掉，不会自动重试。先看已有改动；`run_time_limit` 可以 `resume_worker`（每轮重新计时），`total_time_limit` 只能 `followup_of` 带新 `limits` 接续 |
| worktree 落后主线 | `resume_worker` 带 `rebase_onto: "HEAD"` |
| worker 失败 | 先看 `failure.source` 和 `error`，区分 provider、supervisor、workspace setup、model output、acceptance、worker process |
| worktree 被清掉了 | 照常 `resume_worker` / `land_worker` / `get_worker_diff` / `ask_worker`，会从分支切回来 |

审批、认证、权限、quota 和时间限制造成的停顿不会被自动重试。

## 落地、push 和清理

`land_worker` 只完成本地集成，不等于远端交付。

1. 主线程自己的改动要 commit 并 push。集成分支 push 后用 `verify_push` 证明 landed head 已到远端。它只验证，不替你 push。
2. worker 分支通常不 push。
3. 清理是自动的：已合入或没有改动的 worktree 在轮询时直接删；没合入的保留 7 天，到期先把未提交改动存进它的分支再删。分支、事件、日志、证据永远保留。
4. 想知道某个 worktree 为什么还在，或想立刻清：`cleanup` 的 `action: "plan"` 看判定，`action: "apply"` 带 `plan_id` 和 `item_ids` 清 SAFE 项。

## 常见坑

- worktree 从提交创建。主工作区未提交的东西 worker 看不到，先 commit。
- `exit_code: 0` 不等于业务完成；acceptance 和 diff 才是证据。
- `owned_paths` 的冲突在派单时预留，运行时守卫拦直接写文件，land 再查完整 diff。你放行的脚本仍可能有清单外的副作用，它不是文件系统沙箱。
- worktree 只隔离工作目录。端口、数据库、临时目录仍然共享。
- 看板用 `codex-supervisor-web` 打开 `http://127.0.0.1:7877`。看板只看，不派单、不取消。
- 安装或升级后要重开会话，MCP 和 skill 才会加载新版本。
