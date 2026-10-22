---
name: codex-supervisor
description: 用 Codex CLI 并行做可独立验收的功能包，每路一个 Git worktree，能派单、等待、验收、恢复、合入和清理。用户说“派 codex”“并行跑”“多 agent”“接回旧 worker”时使用。
---

# codex-supervisor

主线程负责拆包、定写集、准备环境、验收和合入。worker 只在自己的 worktree 里完成一个功能包，不负责编排，也不负责交付到远端。

## 什么时候用

适合能拆成几路、每路能单独验收的活，也适合耗时长、中途可能断、需要保留证据的工作。纯问答、单文件小改、需要频繁来回确认的活，主线程自己做更快。

## 派单前必须确认

1. 先 `search_works`，确认没有重复派工。
2. 按功能闭环拆包，不按 DTO、方法或单个测试拆。每路要有清楚的输入、产出和 acceptance。
3. `ownedPaths` 要覆盖完整写集：实现、测试、路由、注册表、DI、配置、迁移、i18n、模板接线都算。拿不准就给唯一模块目录。
4. 依赖必须提前放进 worktree。前端链接 `node_modules` 并执行 `nuxi prepare`；后端初始化 submodule。不要 sleep 抢时间，也不要等主线程事后补。
5. 写 worker 先跑同 contract 的 `preflight_codex_worker`。`get_worker_preflight` 必须是 `passed`，再把 preflight task id 填进 `preflight_id`。`check_acceptance` 不能代替 worker 环境预检。
6. 只要 worker 会 land，就必须有能证明结果的 acceptance。文件存在检查只能当附加条件，不能单独当完成证据。
7. `workspace-write` worker 不执行 `git add`、`git commit` 或 `amend`。验收通过后由主线程 `land_codex_worker(commitMessage)` 代提交并落地。
8. worker 不 push、不合并、不再派生 worker。临时 `codex/<id>` 分支不是交付物。

`preflight_id` 是 AI 派单硬规则。MCP schema 为了兼容旧客户端仍允许省略，但不能把“没被 schema 拒绝”当成可以跳过预检。

## 标准派单

前端示例，preflight 和目标 worker 必须使用同一份 contract：

```json
{
  "workspaceSetup": {
    "links": [{ "path": "node_modules", "source": "node_modules" }],
    "submodules": true,
    "commands": ["npx nuxi prepare"]
  }
}
```

`package.json` 项目如果用 `npm`、`pnpm`、`vitest`、`vue-tsc`、`eslint`、`nuxi` 等本地工具做验收，却没传 `workspaceSetup`，supervisor 会直接返回 `workspace_setup_required`。

## 关键参数

| 参数 | 怎么填 |
|---|---|
| `task` | 写清目标、背景、要改的交付面、边界和验收。不要写“优化一下”。最终报告格式由 supervisor 追加，不在这里重复 |
| `cwd` | Git 项目根，或非 Git 输入目录；实际执行目录由 `workspaceKind` 决定 |
| `workspaceKind` | Git 代码默认 `git_worktree`；非 Git 只读用 `read_only_in_place`；联网研究用 `scratch`；明确授权修改非 Git 目录才用 `in_place_write` |
| `workspaceSetup` | Git worktree 启动前准备依赖。支持 `links`、`submodules`、`commands`。`links.source` 按 `cwd` 解析，也可写绝对路径；链接 `node_modules` 时会给 `.vite`、`.vite-temp`、`.cache` 可写缓存根 |
| `ownedPaths` | 必填。完整写入范围；不同 worker 的写入范围不能重叠。读取不排他。`[]` 只用于不 land 的只读或研究 worker |
| `sandbox` | 默认 `workspace-write`。这个沙箱不能 commit，这是正常边界；不要为了提交改用 `danger-full-access` |
| `preflight_id` | 写 worker 必填。preflight 的 base、`workspaceKind`、`sandbox`、`workspaceSetup`、`ownedPaths`、命令、context、contracts、network、可写根有任何变化都要重跑 |
| `acceptance` | worker 退出后由 supervisor 在 worktree 里执行。worker 自查统一运行 `node "$CODEX_SUPERVISOR_ACCEPTANCE_CLI"`，不要手抄到 zsh；CLI 只读状态库，不需要也不能写 supervisor 数据。每个检查必须真实证明功能 |
| `allowedCommands` | 声明会执行、会写入或有副作用的验证命令。read 命令有安全白名单；命令末尾 `*` 表示只匹配单条命令的前缀 |
| `forbid` | 明确禁止的命令片段。forbid 优先于 allowedCommands 和 acceptance |
| `goal.objective` | 必填。worker 会创建 Codex 原生 goal |
| `goal.tokenBudget` | 可选。不传就是不限预算，worker 必须完全省略 `token_budget`；传 `0`、`1` 或 `null` 会被 runtime guard 拒绝 |
| `session_id` | 同一批使用同一个值。它只负责分组、默认验收和审批，不会把同批 worker 的上下文互相注入 |
| `session_title` | 建议 30 字内，schema 上限 120 字；漏了可用 `describe_session` 补 |
| `dependsOn` | 填上游 task id。上游必须成功结算、acceptance 通过并 `land_codex_worker`，且本路 base 包含上游 landed head |
| `baseRef` | worktree 从哪个提交切。下一步要包含上一步时，填 `codex/<task_id>` 或已集成分支 |

派 `create_codex_worker` 后，回执不回传 task 原文。回执至少带 `id`、`worktree_path`、`branch`、`owned_paths`、`status`；有 base、session、failure 或 run log 时也会返回。

## worker 形状

| 形状 | 参数 | 用途 |
|---|---|---|
| Git 编辑 | `workspaceKind: "git_worktree"`、非空 `ownedPaths` | 改代码、跑 acceptance、等待主线程 land |
| 只读验收 | `workspaceKind: "read_only_in_place"`、`sandbox: "read-only"`、`ownedPaths: []` | 无写入、无网络，只给结论 |
| 联网研究 | `workspaceKind: "scratch"`、`workspace-write`、`networkAccess: true`、`ownedPaths: []` | 可以 curl/gh，只写 supervisor 管理的 scratch，永不 land |
| 非 Git 写入 | `workspaceKind: "in_place_write"`、授权、完整 `ownedPaths`、acceptance | 只改明确授权的非 Git 目录，不能 land |

## 等待与状态

- 日常增量看 `overview_delta`，保存 `next_cursor`。需要全量状态时才用 `get_orchestration_overview`。
- 短等用 `wait_codex_workers`，建议 `timeoutMs: 60000`、`compact: true`。`still_running: true` 只表示这次等待预算用完。
- 长任务用宿主 `/loop 5m check_workers`。不同主线程设置不同的 `CODEX_SUPERVISOR_OBSERVER_ID`。
- `idle_seconds` 是距上一条 Codex 事件的时间。`command_running: true` 时长命令可能仍在跑；没有命令且长时间无事件，再查 `get_codex_worker_events`。
- 不要用 shell 循环 grep `data/runs/*.jsonl` 判断状态。`failed`、`lost`、退出码和恢复状态以 supervisor 状态机为准。

## 收活顺序

1. 先看 `acceptance`。失败时把 `checks[].output_tail` 原样带回 resume，不改验收标准。
2. 读 `get_worker_result`。注意 `commands_run`、命令退出码和 `last_command_failed`，不要只听结论。
3. 读 `get_worker_diff`。默认先看文件和 hunk 索引，再按 `file` + `hunk`/`cursor` 分页读 patch。
4. 对不上就问 `ask_codex_worker`。旁路只读，不改 worker 线程。
5. 要改就 `resume_codex_worker`。不要要求 worker commit 或 amend；主线前进时按需带 `rebaseOnto: "HEAD"`。原生 goal 未明确 complete 或状态不可读时，supervisor 续跑省略 output schema，避免 `ActiveTurnOutputSchemaMismatch`。
6. 验收和 diff 都过了，用 `land_codex_worker({commitMessage})` 把未提交改动提交到 worker 分支并 cherry-pick 到当前集成分支。

`create_codex_followup_worker` 在父任务未 land 时从其 `codex/<parent>` 当前提交起新 worktree；父任务已 land 则用当前集成 HEAD，显式 `baseRef` 优先。父 worktree 未提交改动留在原任务，checkpoint 丢失时先恢复或明确选新 base。整条接续链先审各路 acceptance 和 diff，再用 `land_codex_worker({includeFollowupParents: true, commitMessages: { [task_id]: "..." }})` 按 root-first 落地；途中失败保留已落地部分，修复后重调，不手工压 WIP。

零改动祖先可跳过；`ignoreAcceptance` / `allowOutsideOwned` 只对指定 leaf 生效，不豁免祖先的验收或写入范围。

`invalid_report` 不是业务失败。常见情况是单个字符串字段、缺一个 `]`/`}`，或内容完整但 schema 不合规。先让 `check_workers` 做一次 report-only 修复；仍失败时，acceptance 通过且 diff 审过，可以显式 land。报告只是摘要，不是交付证据。

## 上下文与事实

- worker capsule 只在新派单或 resume 时生成。默认注入 L0 身份、当前任务、依赖摘要和路径/SHA 命中的 verified facts。
- `session_id` peers、完整事件、完整 diff、历史报告和 candidate facts 不会自动注入。
- 主线程看事实摘要用 `search_worker_facts`；追溯来源用 `get_fact`；看证据索引用 `get_worker_evidence` / `get_artifact`。
- worker 的报告先记为 candidate。只有 supervisor acceptance 通过后，才有资格成为当前 work 的 verified outcome。
- base SHA、watched path、context hash 或 in-place manifest 变化后，旧 fact 会过期并从后续 capsule 排除。

## 中断与恢复

| 情况 | 处理 |
|---|---|
| 主线程挂了 | worker 的独立 run host 会继续记录日志、状态和验收。新窗口用 `get_session_works` 接回 |
| worker 变 `lost` | 当前 run 有 durable `turn.completed` 且 worker/run host 均退出时，reconcile 恢复 completed；验收中断仍需重跑。确实中断才 resume，worktree、改动和 thread id 都保留 |
| worktree 落后主线 | `resume_codex_worker` 带 `rebaseOnto: "HEAD"` |
| worker 失败 | 先看 `failure.source` 和 `error`，区分 provider、supervisor、workspace setup、model output、acceptance、worker process |
| 没有 thread id 的旧行 | 用 `create_codex_followup_worker`，通过文本重述上下文 |

`check_workers` 会自动恢复一次已死的第一轮 `lost`、`no_work` 或 `invalid_report`，不会盲重试审批、认证、权限、quota 或时间限制。`completed` 但 `exit_code: null` 是中间态；验收已跑完的 durable 事件会优先于 PID 推断。

## 落地、push 和清理

`land_codex_worker` 只完成本地集成，不等于远端交付。

1. 主线程自己的改动要 commit 并 push。用户批准的集成分支也要在 push 后核对远端 SHA。
2. worker 分支通常不 push。只有用户明确要求保留远端 worker 分支时再推。
3. push 后用 `verify_delivery_push` 证明 landed head 已到远端，并生成 cleanup plan。
4. `check_workers` 只提示清理，不执行删除。
5. 只有 `acceptance passed`、`push_verified`、worktree 干净、没有活跃进程/依赖、fingerprint 未变化的 SAFE item，才可用 `apply_cleanup(plan_id, item_ids)` 删除。
6. cleanup 只执行 `git worktree remove/prune`。task、run event、JSONL、artifact 和 branch 都保留。

## 常见坑

- worktree 从提交创建。主工作区未提交的依赖不会被 worker 看到，先 commit 或用受控 context。
- `exit_code: 0` 不等于业务完成；acceptance 和 diff 才是证据。
- `ownedPaths` 的写冲突在派单时预留。运行时 guard 会拦直接文件写入，land 会再查完整 diff；声明脚本仍可能有清单外副作用，不能把它当完整文件系统沙箱。
- worktree 只隔离工作目录。端口、数据库、临时目录和其它外部资源仍可能共享。
- `resume_codex_worker` 不会再次创建 goal。
- 看板用 `codex-supervisor-web` 打开 `http://127.0.0.1:7877`。看板只观察，不派单、不取消。
- 安装或升级后要重开会话，MCP 和 skill 才会加载新版本。
