import { AnimatePresence, motion } from "motion/react";
import type { SessionDetail } from "../api";
import { clock, plain, relative, sessionLabel } from "../lib/format";
import { StatusBar } from "./StatusMark";
import { WorkerLedger } from "./WorkerLedger";
import { CardRow, HoverCard } from "./HoverCard";

interface Props {
  pages: SessionDetail[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  selectedWorker: string | null;
  onSelectWorker: (id: string) => void;
}

function Stat({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <span className="t-subhead inline-flex items-baseline gap-1.5">
      <span className={`tabular font-semibold ${tone}`}>{value}</span>
      <span className="text-label-2">{label}</span>
    </span>
  );
}

export function SessionBoard({ pages, hasMore, loadingMore, loadMore, selectedWorker, onSelectWorker }: Props) {
  const session = pages[0]!;
  const live = session.active_count > 0;
  const c = session.counts;
  const name = session.title ?? sessionLabel(session.id, session.unsessioned);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 px-8 pt-7 pb-4">
        <motion.div key={session.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
          <HoverCard side="bottom" render={<h2 className={`t-title1 inline-block max-w-full truncate ${session.unsessioned ? "text-label-2" : ""}`}>{name}</h2>}>
            <div className="t-headline">{name}</div>
            <CardRow label="Session id"><span className="mono">{session.id}</span></CardRow>
            <CardRow label="说明">{session.note ?? (session.title_derived ? "没有记录说明。派单时传 session_title / session_note，或调用 describe_session。" : "—")}</CardRow>
            {session.project_roots.length > 0 && (
              <CardRow label="项目根目录"><ul className="mono space-y-0.5">{session.project_roots.map((p) => <li key={p} className="truncate" title={p}>{p}</li>)}</ul></CardRow>
            )}
          </HoverCard>
          <p className="t-subhead mt-1 flex flex-wrap items-center gap-x-3 text-label-2">
            {session.title && !session.unsessioned && <span className="mono">{session.id}</span>}
            <span>首次派单 {clock(session.first_created_at)}</span>
            <span>最近活动 {relative(session.last_activity_at)}</span>
            {session.title_derived && session.title && <span className="text-label-3">标题由各路 goal 拼出，派单时传 session_title 可自定</span>}
          </p>
          {session.note && <p className="t-subhead mt-2 max-w-[72ch] text-label">{session.note}</p>}
        </motion.div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <Stat label="路" value={session.worker_count} />
          <Stat label="运行中" value={c.running ?? 0} tone={live ? "text-orange" : "text-label-3"} />
          <Stat label="完成" value={c.completed ?? 0} tone="text-green" />
          <Stat label="失败" value={c.failed ?? 0} tone={(c.failed ?? 0) > 0 ? "text-red" : "text-label-3"} />
          <Stat label="丢失" value={c.lost ?? 0} tone={(c.lost ?? 0) > 0 ? "text-indigo" : "text-label-3"} />
          <div className="w-40"><StatusBar counts={session.counts} total={session.worker_count} /></div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {live ? (
            <motion.section key="now" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
              <div className="inset mt-5 px-4 py-3">
                <div className="group-header">正在进行</div>
                <ul className="mt-1 divide-y divide-separator-soft">
                  {session.now.map((line) => (
                    <li key={line.id} className="flex min-h-[36px] items-center gap-3">
                      <button type="button" onClick={() => onSelectWorker(line.id)} className="t-subhead shrink-0 text-blue">
                        {line.title.length > 32 ? `${line.title.slice(0, 32)}…` : line.title}
                      </button>
                      <span className="t-footnote mono truncate text-label-2">{line.current_action ?? line.phase ?? "…"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </motion.section>
          ) : session.last_report ? (
            <motion.section key="last" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
              <div className="inset mt-5 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="group-header">最近一条汇报</span>
                  <button type="button" onClick={() => onSelectWorker(session.last_report!.id)} className="t-footnote truncate text-blue">{session.last_report.title}</button>
                  <span className="t-caption ml-auto shrink-0 text-label-2">{relative(session.last_report.at)}</span>
                </div>
                <p className="t-subhead mt-1 line-clamp-2 text-label">{plain(session.last_report.text, 260)}</p>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <div className="group-header mb-2">Worker（按派单顺序）</div>
        <WorkerLedger pages={pages} hasMore={hasMore} loadingMore={loadingMore} loadMore={loadMore} selected={selectedWorker} onSelect={onSelectWorker} />
      </div>
    </div>
  );
}
