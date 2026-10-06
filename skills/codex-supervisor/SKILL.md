---
name: codex-supervisor
description: 把 Codex CLI 当并行 worker 派活、盯进度、收结果。用户说"派 codex 干""并行跑""开几个 worker""这批活分几路""多 agent 做"时用；工作线程断了要接回来、要查以前派过什么活，也用这个。
---

# codex-supervisor

主线程派活给 Codex worker，一个 worker 一个独立 Git worktree，状态全部落盘。

## 什么时候用

- 一批能拆开的活：改 5 个模块、写 6 篇文档、清点 3 个仓库
- 活偏大，不想让它占自己的上下文
- 跑到一半可能断，需要能接回来

**不用**：一个文件的小改、纯问答、需要来回确认的活。这些自己干更快。

## 一次派单

1. 拆活。每路写清楚：干什么、能写哪些文件、怎么算做完。
2. `create_codex_worker` 派出去。返回的是一张精简回执（`id`、`worktree_path`、`branch`、`owned_paths`、`status`），任务原文不回传，派十一路也不会把你的提示词抄十一遍。
3. 派完就 `wait_codex_workers` 等。默认只等 2 分钟，到点返回进度快照，worker 照跑；拿同一批 `task_ids` 接着调，直到 `timed_out: false`。
4. 收结果走 `get_worker_result`，拿完整汇报，别一上来读事件流。

`ownedPaths` 和 `goal` 必填，不是可选项。

`wait_codex_workers` 的等待预算管的是这一次调用，不是 worker。返回里 `still_running: true` 是等满了，不是活挂了，按 `next_step` 接着调就行。别把 `timeoutMinutes` 开到超过客户端的 MCP 工具超时——那样被掐掉的是这次调用，丢的是这次的结果。

| 参数 | 怎么填 |
|---|---|
| `task` | 这一路具体干什么。要能让对方直接开工，别写"优化一下" |
| `cwd` | 项目根目录。worker 在它的 worktree 里干活，不动你的工作区 |
| `ownedPaths` | 这个 worker 允许写的路径。和正在跑的 worker 重叠会被拒，返回冲突的 `task_id` |
| `goal.objective` | 一句话说清这路活的目标 |
| `session_id` | 同一批派单传同一个值。断线重连靠它 |
| `dependsOn` | 有先后依赖时填上游的 `task_id` |

一次派一批：

```
create_codex_worker × N   （同一个 session_id）
wait_codex_workers        （task_ids: [...], mode: "all"）
```

## 读结果别把上下文撑爆

按这个顺序读，能不动后面就别动：

| 想干什么 | 用哪个 | 代价 |
|---|---|---|
| 看全部 worker 现在什么状态 | `get_orchestration_overview` | ~1750 token，封顶 |
| 收一路活的完整结论 | `get_worker_result` | 汇报全文，大活可能上万字 |
| 只想知道活着还是完了 | `get_worker_summary` | 一段话 |
| 看某个 worker 干了什么 | `get_codex_worker_events` | 用 `limit` / `kinds` / `maxChars` 压 |
| 看某个 worker 的完整记录 | `get_codex_worker_status` | 中等，比 overview 一行细 |
| 看 goal 和 token 消耗 | `get_worker_goal` | 很小 |

**收结论必须走 `get_worker_result`。** `wait_codex_workers` 返回里的 `last_message` 会被截到 400 字只留开头，`get_orchestration_overview` 干脆不给这一列。拿截断版当结论，后面的证据、数字和结论全会漏掉。`get_worker_result` 还会带回 `status`、`exit_code`、`changed_files`，顺便就能判断是真跑完还是崩了。

`get_codex_worker_events` 的三个闸门：`kinds` 先过滤再取 `limit`；`maxChars` 把超长字符串中间截断；不知道有哪些 `kinds` 时先看返回里的 `available_kinds`。

**别做**：一次 `limit: 200` 拉全量事件。那是几万 token。

## 中断了怎么接

先分清是哪种断：

| 情况 | 用什么 | 效果 |
|---|---|---|
| 想接着**同一个** Codex 会话干 | `resume_codex_worker` | 上下文不丢，`thread_id` 不变 |
| 想开**新会话**，带着老活的摘要干 | `create_codex_followup_worker` | 新线程，靠文本重述 |
| 主线程自己挂了，要找回那批活 | `get_session_works` | 按 `session_id` 列全部 |

主线程重启后第一件事：`get_session_works({ session_id })`。一次拿到那批活的清单和状态，不用凭记忆猜。

`resume_codex_worker` 只有在原任务记了 `thread_id` 时能用。没记过就用 `create_codex_followup_worker`。

## 找以前的活

`search_works({ query })` 在 title、goal、prompt、last_message 里做子串匹配，从新到旧返回。

想按状态筛就用 `list_codex_workers({ status, includeHistory: true })`。

## 状态怎么读

`status` 是生命周期，一个 work 一个值：`queued` / `running` / `completed` / `failed` / `cancelled` / `lost`。

`phase` 只在跑着的时候有值：`starting` → `thinking` → `command` → `editing` → `reporting`。

**`failed` 和 `lost` 不是一回事**：

- `failed`：跑完了但没成。去看日志和 `error`。
- `lost`：进程被外部信号杀了，或者 MCP 进程自己没了。什么都没说。**直接重跑**，不用查日志。

`paused` 和 `blocked` 的 goal 不是结束，是等人管。`get_orchestration_overview` 会把它们列进 `needs_attention`。

## goal 是干嘛的

每个 worker 起手会自己调 Codex 的 `create_goal`，把 `goal.objective` 建成那个线程的原生 goal；干完调 `update_goal` 标 `complete`。所以：

- `get_worker_goal` 里的 `native_goal` 是 Codex 自己的记录，带真实 token 和时间消耗
- Go 到 Codex 界面上能直接看到这个 goal
- `resume_codex_worker` **不会**再建 goal（有未完成 goal 时 `create_goal` 会失败）

## 常见坑

- **worker 的命绑在 MCP 进程上**。MCP 被 kill，正在跑的 worker 会被留下，下次读状态时结算成 `lost`。
- **worktree 是从 `HEAD` 建的，你工作区里没 commit 的东西不在里面**。未提交的修改和未跟踪文件 worker 既看不到也写不到。要让它读到就把绝对路径写进 `task`，或者先把改动 commit。它自己的改动落在 `codex/<taskId>` 分支上，不碰你的工作区。
- **它只管"跑完了"，不管写得对不对**。终态来自 Codex 的 `turn.completed` 和进程退出码，`exit_code: 0` 只说明没崩。每批活回来，验收得自己做：跑校验、抽看内容。
- **`ownedPaths` 冲突是好事**。说明两路活会踩同一个文件，这时候该改拆法，不是绕过检测。
- **worktree 只隔离工作区，不隔离端口和数据库**。多路活要是都会连同一个 dev server 或同一个库，得自己错开。
- **`cancel_codex_worker` 跨进程靠 pid**。要求那个 pid 的命令行里带 `codex`，防止误杀复用 pid 的进程。

## 收尾

一批活全部到终态后：

1. `get_orchestration_overview` 确认没有 `needs_attention`
2. 逐路 `get_worker_result` 拿完整汇报，对着验收标准核内容
3. 失败的区分 `failed`（查原因）和 `lost`（重跑）
4. 改动在各自 worktree 的 `codex/<taskId>` 分支上，合并由主线程决定
