# codex-supervisor-mcp

把 Codex CLI 当 worker 派出去干活，一个 worker 一个独立 Git worktree，状态全部落盘。

主线程（Claude Code、Codex、任何 MCP 客户端）用它的 7 个工具派单、等待、查状态、读事件、取消。

## 它解决什么

直接让多个 agent 同时改一个仓库，结果是互相覆盖、没人知道谁改了什么。这个 MCP 把「派单」和「记账」从模型上下文里拿出来，落到磁盘上：

| 问题 | 做法 |
|---|---|
| 多个 worker 互相踩文件 | 每个 worker 一个 Git worktree |
| 主线程上下文塞不下 worker 的过程 | 原始事件流写 `data/runs/<taskId>.jsonl`，只在需要时读 |
| 进程重启后不知道谁还在跑 | `supervisor.sqlite` 里一行一个 worker 快照 |
| worker 卡住了没人管 | `wait_codex_workers` 阻塞等待 + 超时 |

## 架构

```
MCP client (Claude Code / Codex / ...)
   │  stdio (MCP)
   ▼
codex-supervisor-mcp
   │  spawn: codex exec --json
   ▼
Codex worker  ──►  data/runs/<taskId>.jsonl      原始 JSONL 事件流
              ──►  supervisor.sqlite              tasks + task_events
              ──►  worktrees/<taskId>/            独立 Git worktree
```

## 安装

需要 Node.js >= 22 和 `codex` CLI 在 `PATH` 里。

```bash
npm install -g codex-supervisor-mcp
```

### 配置到 Claude Code

在项目的 `.mcp.json` 里：

```json
{
  "mcpServers": {
    "codex-supervisor": {
      "command": "npx",
      "args": ["-y", "codex-supervisor-mcp"]
    }
  }
}
```

### 配置到 Codex

```bash
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

## 工具

| 工具 | 入参 | 作用 |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | 起一个 worker |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, + 同上 | 承接上一个 worker 的上下文再起一个 |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | 列出在跑的 worker |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `includeEvents`, `eventLimit` | 阻塞等完成，回摘要 |
| `get_codex_worker_status` | `task_id` | 单个 worker 最新状态 |
| `get_codex_worker_events` | `task_id`, `limit` | 读原始事件流 |
| `cancel_codex_worker` | `task_id` | 终止 worker 进程 |

## 状态存储

默认写在 `~/.codex-supervisor/`：

| 文件 | 内容 |
|---|---|
| `data/supervisor.sqlite` | `tasks`（一行一个 worker）+ `task_events`（结构化事件，带 `seq`） |
| `data/runs/<taskId>.jsonl` | Codex `--json` 原始输出，逐行事件 |
| `worktrees/<taskId>/` | 该 worker 的独立 Git worktree |

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | 状态根目录（sqlite / 事件流 / worktree 都在它下面） |
| `CODEX_BIN` | `codex`（走 `PATH`） | Codex CLI 可执行文件路径 |
| `GIT_BIN` | `git`（走 `PATH`） | Git 可执行文件路径 |

如果 MCP 客户端启动时 `PATH` 里没有 `codex`（GUI 启动的应用常见），显式设置 `CODEX_BIN`：

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

## 已知限制

- **worker 进程句柄存在内存里**：`cancel_codex_worker` 换一个进程调用会返回 `process_not_found`。
- **spawn 失败会打死整个 MCP 进程**：`codex` 不存在时没有 `child.on("error")` 兜底，会抛 `uncaughtException: spawn ENOENT`。
- **stdin 写入失败会打死进程**：prompt 很大而子进程提前退出时，`child.stdin.end()` 会抛 `write EPIPE`。
- **没有 goal**：不往 Codex 原生的 `thread_goals` 写数据，主线程无法从 goal 层拿到验收标准和预算。
- **没有文件所有权校验**：两个 worker 可以派到同一个文件，没有冲突检测。

## Roadmap

1. ~~去个人化：`CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN` 环境变量~~ ✅ 已完成
2. 修两个崩溃：spawn ENOENT、stdin EPIPE 会打死整个 MCP 进程
3. 文件所有权：`create_codex_worker` 加 `ownedPaths`，派单前做冲突检测
4. goal 层：接 Codex 原生 `thread/goal/*`，并加跨 worker 依赖边
5. 常驻 daemon：派单和进程生命周期从 MCP 进程里拿出来
6. React 实时看板

## 开发

```bash
npm install
npm run smoke          # 基础冒烟
npm run smoke:mcp      # MCP 协议冒烟
npm run monitor        # Ink 终端看板
```

## License

MIT
