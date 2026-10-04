#!/usr/bin/env node
import React, { useEffect, useMemo, useState } from "react";
import { Box, Newline, render, Text, useApp, useInput, useStdout } from "ink";
import { readTaskEvents, readTasks, reconcileDetachedActiveTasks } from "./task-store.js";

const REFRESH_MS = 1000;
const STATUS_LABELS = {
  queued: "排队中",
  running: "运行中",
  editing: "编辑中",
  command: "执行命令",
  command_completed: "命令完成",
  reporting: "汇报中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const PHASE_LABELS = {
  queued: "排队中",
  starting: "启动中",
  thinking: "思考中",
  editing: "编辑中",
  command: "执行命令",
  command_completed: "命令完成",
  reporting: "汇报中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};
const ACTIVE_STATUSES = new Set(["queued", "running", "editing", "command", "command_completed", "reporting"]);

function truncate(value, width) {
  const text = String(value ?? "");
  if (width <= 1) return "";
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function statusColor(status) {
  if (status === "completed") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "running") return "cyan";
  if (status === "queued") return "yellow";
  return "white";
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? "-";
}

function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? phase ?? "-";
}

function eventSummary(event) {
  const type = event?.type ?? "unknown";
  const item = event?.item;
  if (!item) return type;

  if (item.type === "agent_message") {
    return `${type} agent_message: ${truncate(item.text, 120)}`;
  }
  if (item.type === "command_execution") {
    return `${type} command: ${truncate(item.command ?? item.cmd ?? item.text ?? "", 120)}`;
  }
  if (item.type === "file_change") {
    return `${type} file_change: ${truncate(item.path ?? item.file ?? item.file_path ?? "", 120)}`;
  }
  return `${type} ${item.type ?? ""}`.trim();
}

function eventActor(event) {
  const type = event?.type ?? "";
  const itemType = event?.item?.type;
  if (itemType === "agent_message") return "agent";
  if (itemType === "command_execution") return "cmd";
  if (itemType === "file_change") return "file";
  if (type.startsWith("turn.")) return "turn";
  if (type.startsWith("thread.")) return "thread";
  return "event";
}

function eventColor(event) {
  const actor = eventActor(event);
  if (actor === "agent") return "green";
  if (actor === "cmd") return "yellow";
  if (actor === "file") return "magenta";
  if (actor === "turn") return "cyan";
  return "gray";
}

function eventOutput(event) {
  const item = event?.item;
  if (item?.type === "agent_message") return item.text ?? "";
  if (item?.type === "command_execution") {
    const command = item.command ?? item.cmd ?? item.text ?? "";
    const status = item.status ? ` ${item.status}` : "";
    const exitCode = item.exit_code ?? item.exitCode;
    const exitText = exitCode === undefined || exitCode === null ? "" : ` exit=${exitCode}`;
    return `${command}${status}${exitText}`.trim();
  }
  if (item?.type === "file_change") {
    return item.path ?? item.file ?? item.file_path ?? JSON.stringify(item);
  }
  if (event?.type === "turn.completed") return "turn completed";
  if (event?.type === "turn.failed") return `turn failed: ${event.error ?? event.message ?? ""}`.trim();
  if (event?.type === "thread.started") return `thread ${event.thread_id ?? ""}`.trim();
  return eventSummary(event);
}

function useSupervisorData(selectedIndex, showAll) {
  const [tasks, setTasks] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        await reconcileDetachedActiveTasks();
        const allTasks = await readTasks();
        const nextTasks = showAll ? allTasks : allTasks.filter((task) => ACTIVE_STATUSES.has(task.status));
        if (!active) return;
        setTotalCount(allTasks.length);
        setTasks(nextTasks);
        const selected = nextTasks[selectedIndex] ?? nextTasks[0];
        const nextEvents = selected ? await readTaskEvents(selected.id, 80) : [];
        if (!active) return;
        setEvents(nextEvents);
        setError(null);
      } catch (refreshError) {
        if (active) setError(refreshError.message);
      }
    }

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedIndex, showAll]);

  return { tasks, totalCount, events, error };
}

function Header({ showAll }) {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold>Codex 监督台</Text>
      <Text dimColor>
        {" "}q/Esc: 退出  ↑/↓ 或 j/k: 切换 worker  a: {showAll ? "只看活跃" : "看全部/历史"}  每秒自动刷新
      </Text>
    </Box>
  );
}

function ClaudePlanPanel({ width }) {
  return (
    <Box borderStyle="single" flexDirection="column" width={width} paddingX={1}>
      <Text bold color="magenta">Claude CLI 总控</Text>
      <Text dimColor>Claude 负责计划、派工、审查；这里负责观察状态。</Text>
      <Newline />
      <Text>1. Claude 先列计划和验收标准。</Text>
      <Text>2. 前端/后端/测试拆成不同 Codex worker。</Text>
      <Text>3. 右侧看每个 worker 当前状态。</Text>
      <Text>4. 底部看输入、输出、事件和错误。</Text>
      <Text>5. 完成后让 Claude 或 Codex review worker 审查。</Text>
      <Newline />
      <Text dimColor>Claude 可调用的 MCP 工具名:</Text>
      <Text dimColor>create_codex_worker</Text>
      <Text dimColor>create_codex_followup_worker</Text>
      <Text dimColor>list_codex_workers</Text>
      <Text dimColor>get_codex_worker_status</Text>
      <Text dimColor>get_codex_worker_events</Text>
      <Text dimColor>cancel_codex_worker</Text>
    </Box>
  );
}

function WorkersPanel({ tasks, selectedIndex, width, showAll, totalCount }) {
  return (
    <Box borderStyle="single" flexDirection="column" width={width} paddingX={1}>
      <Text bold color="cyan">
        Codex 执行队列 <Text dimColor>{showAll ? `全部 ${totalCount}` : `活跃 ${tasks.length} / 全部 ${totalCount}`}</Text>
      </Text>
      {tasks.length === 0 ? (
        <Text dimColor>{showAll ? "暂无 worker。请在 Claude CLI 里创建任务。" : "暂无活跃 worker。按 a 查看历史。"}</Text>
      ) : (
        tasks.map((task, index) => {
          const selected = index === selectedIndex;
          const marker = selected ? ">" : " ";
          const title = truncate(task.title ?? task.id, Math.max(16, width - 44));
          const phase = truncate(phaseLabel(task.phase), 18);
          const action = truncate(task.current_command ?? task.current_action ?? task.last_message ?? "", Math.max(12, width - 58));
          return (
            <Text key={task.id} inverse={selected}>
              {marker} <Text color={statusColor(task.status)}>{truncate(statusLabel(task.status), 10).padEnd(10)}</Text>{" "}
              {phase.padEnd(18)} {title} <Text dimColor>{action}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

function DetailPanel({ task, events, height }) {
  const shownEvents = useMemo(() => events.slice(-Math.max(4, height - 12)), [events, height]);

  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1} minHeight={height}>
      <Text bold color="green">当前 Worker 详情</Text>
      {!task ? (
        <Text dimColor>未选中 worker。</Text>
      ) : (
        <>
          <Text>ID: {task.id}</Text>
          <Text>
            状态: <Text color={statusColor(task.status)}>{statusLabel(task.status)}</Text>  阶段: {phaseLabel(task.phase)}
          </Text>
          <Text>思考强度: {task.reasoning_effort ?? "high"}</Text>
          <Text>执行目录: {truncate(task.cwd, 120)}</Text>
          {task.worktree_path ? <Text>隔离 worktree: {truncate(task.worktree_path, 120)}</Text> : null}
          {task.followup_of ? <Text>续跑来源: {task.followup_of}</Text> : null}
          <Text>当前动作: {truncate(task.current_action ?? task.last_message ?? "-", 120)}</Text>
          {task.current_command ? <Text>当前命令: {truncate(task.current_command, 120)}</Text> : null}
          <Text>变更文件数: {(task.changed_files ?? []).length}</Text>
          <Text dimColor>输入 prompt:</Text>
          <Text>{truncate(task.prompt, 160)}</Text>
          <Text dimColor>最近输出 / item 事件:</Text>
          {shownEvents.length === 0 ? (
            <Text dimColor>暂无事件。</Text>
          ) : (
            shownEvents.map((event, index) => (
              <Text key={`${event.type}-${index}`}>
                <Text color={eventColor(event)}>{eventActor(event).padEnd(6)}</Text>{" "}
                <Text dimColor>{truncate(event.type ?? "unknown", 18).padEnd(18)}</Text>{" "}
                {truncate(eventOutput(event), 132)}
              </Text>
            ))
          )}
        </>
      )}
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns ?? 120;
  const terminalHeight = stdout.rows ?? 36;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const { tasks, totalCount, events, error } = useSupervisorData(selectedIndex, showAll);

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
    if (input === "a") {
      setSelectedIndex(0);
      setShowAll((current) => !current);
    }
    if (input === "j" || key.downArrow) {
      setSelectedIndex((current) => Math.min(Math.max(tasks.length - 1, 0), current + 1));
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
    }
  });

  useEffect(() => {
    if (selectedIndex >= tasks.length) {
      setSelectedIndex(Math.max(0, tasks.length - 1));
    }
  }, [selectedIndex, tasks.length]);

  const leftWidth = Math.max(38, Math.floor(terminalWidth * 0.36));
  const rightWidth = Math.max(50, terminalWidth - leftWidth - 2);
  const selectedTask = tasks[selectedIndex] ?? null;
  const detailHeight = Math.max(12, terminalHeight - 16);

  return (
    <Box flexDirection="column">
      <Header showAll={showAll} />
      {error ? <Text color="red">错误: {error}</Text> : null}
      <Box>
        <ClaudePlanPanel width={leftWidth} />
        <WorkersPanel tasks={tasks} selectedIndex={selectedIndex} width={rightWidth} showAll={showAll} totalCount={totalCount} />
      </Box>
      <DetailPanel task={selectedTask} events={events} height={detailHeight} />
    </Box>
  );
}

render(<App />);
