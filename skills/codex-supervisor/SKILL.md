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
2. `create_codex_worker` 派出去。
3. 派完就 `wait_codex_workers` 等，别轮询。
4. 收结果走 `get_worker_summary`，别一上来读事件流。

`ownedPaths` 和 `goal` 必填，不是可选项。

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
| 收一路活的结果 | `get_worker_summary` | 一段话 |
| 看某个 worker 干了什么 | `get_codex_worker_events` | 用 `limit` / `kinds` / `maxChars` 压 |
| 看某个 worker 的完整记录 | `get_codex_worker_status` | 中等，比 overview 一行细 |
| 看 goal 和 token 消耗 | `get_worker_goal` | 很小 |

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
- **`ownedPaths` 冲突是好事**。说明两路活会踩同一个文件，这时候该改拆法，不是绕过检测。
- **worktree 只隔离工作区，不隔离端口和数据库**。多路活要是都会连同一个 dev server 或同一个库，得自己错开。
- **`cancel_codex_worker` 跨进程靠 pid**。要求那个 pid 的命令行里带 `codex`，防止误杀复用 pid 的进程。

## 收尾

一批活全部到终态后：

1. `get_orchestration_overview` 确认没有 `needs_attention`
2. 逐路 `get_worker_summary`
3. 失败的区分 `failed`（查原因）和 `lost`（重跑）
4. 改动在各自 worktree 的 `codex/<taskId>` 分支上，合并由主线程决定
