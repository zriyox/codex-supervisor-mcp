import { useState } from "react";
import { Tabs } from "@base-ui-components/react/tabs";
import { motion } from "motion/react";
import { X } from "@phosphor-icons/react";
import { useEvents, useWorker, type WorkerDetail } from "../api";
import { clock, duration, relativeToWorktree, tokens } from "../lib/format";
import { StatusText } from "./StatusMark";
import { EventStream } from "./EventStream";
import { Markdown } from "./Markdown";

interface Props {
  workerId: string;
  onClose: () => void;
  onOpenWorker: (id: string) => void;
}

// Inspector rows: label left, value right, hairline between. The Finder
// "Get Info" shape, which every Mac user already knows how to read.
function KV({ label, children, mono = false, title }: { label: string; children: React.ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="flex min-h-[36px] items-center gap-4 py-1.5">
      <span className="t-subhead w-20 shrink-0 text-label-2">{label}</span>
      <span className={`t-subhead min-w-0 flex-1 truncate text-right ${mono ? "mono" : ""}`} title={title}>{children}</span>
    </div>
  );
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      {title && <div className="group-header mb-1.5 px-1">{title}</div>}
      <div className="inset divide-y divide-separator-soft px-4">{children}</div>
    </section>
  );
}

// Codex repeats its startup warnings on every run of a thread. Show each
// distinct sentence once, folded by default.
function Notices({ text }: { text: string }) {
  const lines = Array.from(new Set(text.split(/(?<=\.)\s+(?=[A-Z])|\n+/).map((l) => l.trim()).filter(Boolean)));
  return (
    <details className="group mt-4 px-1">
      <summary className="t-footnote cursor-pointer list-none text-label-2 hover:text-label">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
        Codex 提示 {lines.length} 条
      </summary>
      <ul className="t-footnote mt-1.5 space-y-1 pl-4 text-label-2">
        {lines.map((l) => <li key={l} className="list-disc">{l}</li>)}
      </ul>
    </details>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="t-subhead py-10 text-center text-label-2">{children}</p>;
}

function Reports({ worker }: { worker: WorkerDetail }) {
  if (worker.reports.length === 0) return <Empty>这路 worker 还没有汇报。</Empty>;
  const list = [...worker.reports].reverse();
  return (
    <div className="space-y-3">
      {list.map((text, i) => (
        <article key={i} className="inset px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="group-header">{i === 0 ? "最终汇报" : `之前的汇报 ${list.length - i}`}</span>
            <span className="t-caption ml-auto text-label-3">{text.length} 字</span>
          </div>
          <Markdown text={text} className="mt-2" />
        </article>
      ))}
    </div>
  );
}

function Changes({ worker }: { worker: WorkerDetail }) {
  if (worker.changed_files.length === 0) return <Empty>没有改动：worktree 没有未提交的文件，分支上也没有新提交。</Empty>;
  return (
    <ul className="inset divide-y divide-separator-soft px-4">
      {worker.changed_files.map((file) => (
        <li key={file} className="t-subhead mono flex min-h-[36px] items-center py-1.5" title={file}>
          <span className="truncate">{relativeToWorktree(file, worker.worktree_path)}</span>
        </li>
      ))}
    </ul>
  );
}

function Commands({ worker }: { worker: WorkerDetail }) {
  if (worker.commands.length === 0) return <Empty>没跑过命令。</Empty>;
  const list = [...worker.commands].reverse();
  return (
    <ol className="inset divide-y divide-separator-soft px-4">
      {list.map((entry, i) => {
        const bad = entry.exit_code !== null && entry.exit_code !== 0;
        return (
          <li key={i} className="py-2.5">
            <div className="t-caption flex items-center gap-2">
              <span className={`tabular ${bad ? "text-red" : "text-green"}`}>exit {entry.exit_code ?? "?"}</span>
              <span className="ml-auto text-label-3">{clock(entry.completed_at)}</span>
            </div>
            <pre className="t-footnote mono mt-1 whitespace-pre-wrap break-all text-label">{entry.command}</pre>
          </li>
        );
      })}
    </ol>
  );
}

const TABS = [
  { value: "report", label: "汇报" },
  { value: "changes", label: "改动" },
  { value: "commands", label: "命令" },
  { value: "events", label: "事件" },
  { value: "prompt", label: "任务书" }
] as const;
type TabValue = (typeof TABS)[number]["value"];

export function WorkerDrawer({ workerId, onClose, onOpenWorker }: Props) {
  const [tab, setTab] = useState<TabValue>("report");
  const { data: worker, error } = useWorker(workerId);
  const { data: eventData } = useEvents(workerId, tab === "events");
  const counts: Partial<Record<TabValue, number>> = worker
    ? { changes: worker.changed_files.length, commands: worker.command_count, events: worker.event_kinds.reduce((n, k) => n + k.count, 0) }
    : {};
  // A resumed worker records resumed_from = its own id (same row, more runs);
  // only a genuinely different parent is worth a link.
  const rawParent = worker?.followup_of ?? worker?.resumed_from ?? null;
  const parent = rawParent && rawParent !== worker?.id ? rawParent : null;

  return (
    <motion.section
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.24, ease: [0.25, 0.1, 0.25, 1] }}
      className="flex h-full min-h-0 flex-col border-l border-separator-soft bg-bg"
      aria-label="worker 详情"
    >
      {!worker && <p className="t-subhead p-8 text-label-2">{error ? `读取失败：${error.message}` : "读取中…"}</p>}
      {worker && (
        <>
          <header className="shrink-0 px-6 pt-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <StatusText status={worker.status} phase={worker.phase} className="t-footnote" />
                <h2 className="t-title2 mt-1">{worker.title}</h2>
                {worker.goal && <p className="t-subhead mt-1 text-label-2">{worker.goal}</p>}
              </div>
              <button type="button" onClick={onClose} aria-label="关闭" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-fill text-label-2 hover:bg-fill-2">
                <X size={14} weight="bold" />
              </button>
            </div>
            {worker.status === "running" && worker.current_action && (
              <p className="t-footnote mono mt-3 truncate text-orange" title={worker.current_action}>{worker.current_action}</p>
            )}
            {worker.error && <p className="t-subhead mt-3 rounded-lg bg-red/10 px-3 py-2 text-red">{worker.error}</p>}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
            <Group>
              <KV label="耗时">{duration(worker.duration_ms)}</KV>
              <KV label="开始" mono>{clock(worker.started_at ?? worker.created_at)}</KV>
              <KV label="结束" mono>{clock(worker.completed_at)}</KV>
              <KV label="退出码" mono>{worker.exit_code ?? "—"}</KV>
              <KV label="运行次数" mono>{worker.run_count}</KV>
            </Group>
            <Group>
              <KV label="模型" mono>{worker.model ?? "默认"}</KV>
              <KV label="tokens" mono title={`输入 ${worker.usage.input_tokens}（缓存命中 ${worker.usage.cached_input_tokens}）/ 输出 ${worker.usage.output_tokens} / ${worker.usage.turns} turn`}>
                {tokens(worker.usage.input_tokens)} in · {tokens(worker.usage.output_tokens)} out
              </KV>
              <KV label="沙箱" mono>{worker.sandbox}</KV>
              <KV label="thread" mono title={worker.thread_id ?? ""}>{worker.thread_id ?? "—"}</KV>
              <KV label="worker" mono title={worker.id}>{worker.id}</KV>
              <KV label="session" mono>{worker.session_id ?? "—"}</KV>
              {worker.pid && worker.status === "running" && <KV label="pid" mono>{worker.pid}</KV>}
            </Group>
            <Group>
              <KV label="分支" mono title={worker.branch ?? ""}>{worker.branch ?? "—"}</KV>
              <KV label="基线" mono title={worker.base_commit ?? ""}>{worker.base_commit ? worker.base_commit.slice(0, 12) : "—"}</KV>
              <KV label="worktree" mono title={worker.worktree_path ?? ""}>{worker.worktree_path ?? "—"}</KV>
              {parent && (
                <KV label={worker.followup_of ? "接续自" : "续跑自"} mono>
                  <button type="button" className="text-blue" onClick={() => onOpenWorker(parent)}>{parent}</button>
                </KV>
              )}
            </Group>
            {worker.notices && <Notices text={worker.notices} />}

            <Tabs.Root value={tab} onValueChange={(v) => setTab(v as TabValue)} className="mt-6">
              {/* Segmented control: equal segments, selected one raised. */}
              <Tabs.List className="relative grid grid-cols-5 rounded-lg bg-fill p-0.5">
                {TABS.map((t) => (
                  <Tabs.Tab key={t.value} value={t.value} className="t-footnote relative z-10 flex h-8 items-center justify-center gap-1 rounded-md font-medium text-label-2 outline-none transition-colors data-[selected]:text-label focus-visible:ring-2 focus-visible:ring-blue">
                    {t.label}
                    {counts[t.value] ? <span className="tabular text-label-3">{counts[t.value]}</span> : null}
                    {tab === t.value && <motion.span layoutId="segment" className="absolute inset-0 -z-10 rounded-md bg-bg-2 shadow-[0_1px_3px_rgb(0_0_0/0.12)]" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              <div className="mt-3">
                <Tabs.Panel value="report"><Reports worker={worker} /></Tabs.Panel>
                <Tabs.Panel value="changes"><Changes worker={worker} /></Tabs.Panel>
                <Tabs.Panel value="commands"><Commands worker={worker} /></Tabs.Panel>
                <Tabs.Panel value="events" className="h-[60vh]"><EventStream events={eventData?.events ?? []} /></Tabs.Panel>
                <Tabs.Panel value="prompt"><pre className="inset t-subhead whitespace-pre-wrap break-words px-4 py-3 font-sans text-label">{worker.prompt ?? "—"}</pre></Tabs.Panel>
              </div>
            </Tabs.Root>
          </div>
        </>
      )}
    </motion.section>
  );
}
