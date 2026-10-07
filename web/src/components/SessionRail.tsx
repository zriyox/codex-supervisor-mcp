import { useVersion, type Overview, type SessionSummary } from "../api";
import { useLoadMore } from "../lib/useLoadMore";
import { relative, sessionLabel } from "../lib/format";
import { StatusDot } from "./StatusMark";

interface Props {
  pages: Overview[] | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
}

function Row({ session, active, onSelect }: { session: SessionSummary; active: boolean; onSelect: () => void }) {
  const live = session.active_count > 0;
  const name = session.title ?? sessionLabel(session.id, session.unsessioned);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 ${
        active ? "bg-blue/12 text-label" : "hover:bg-fill"
      }`}
    >
      {live ? <StatusDot status="running" size={8} /> : <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-fill-2" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className={`t-subhead block truncate ${session.unsessioned ? "italic text-label-2" : ""}`}>{name}</span>
        <span className="t-caption block truncate text-label-2">
          {live ? <span className="text-orange">{session.active_count} 路运行中</span> : relative(session.last_activity_at)}
          {session.title && !session.unsessioned && <span className="mono"> · {session.id}</span>}
        </span>
      </span>
      <span className="t-caption mono shrink-0 rounded-full bg-fill px-2 py-0.5 text-label-2">{session.worker_count}</span>
    </button>
  );
}

// The version line at the foot of the sidebar. Quiet when current; a
// yellow notice with the install command when a newer build is published
// or the installed files do not match the published tarball.
function VersionFooter() {
  const { data } = useVersion();
  if (!data) return null;
  const attention = data.update_available || data.integrity_matches === false;
  return (
    <div className={`border-t border-separator-soft px-5 py-3 ${attention ? "bg-yellow/15" : ""}`}>
      <div className="t-caption flex items-center gap-2 text-label-2">
        <span className="mono">v{data.installed.version}</span>
        {data.latest && !attention && <span>已是最新</span>}
        {data.source === "offline" && <span title={data.error ?? ""}>未能联系 npm</span>}
      </div>
      {attention && (
        <div className="t-footnote mt-1 text-label">
          {data.update_available ? <>有新版本 <span className="mono">{data.latest?.version}</span>。</> : <>安装文件与发布版不一致。</>}
          <code className="mono mt-1 block select-all rounded bg-fill px-2 py-1 text-[12px]">{data.install_command}</code>
          <span className="t-caption text-label-2">装完重启 Claude Code / Codex 才会换成新版本。</span>
        </div>
      )}
    </div>
  );
}

export function SessionRail({ pages, hasMore, loadingMore, loadMore, selected, onSelect }: Props) {
  const overview = pages?.[0];
  const sessions = pages?.flatMap((p) => p.sessions) ?? [];
  const live = sessions.filter((s) => s.active_count > 0);
  const idle = sessions.filter((s) => s.active_count === 0);
  const sentinel = useLoadMore(hasMore, loadingMore, loadMore);
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-separator-soft bg-bg-2">
      <div className="px-5 pt-5 pb-3">
        <h1 className="t-title2">Sessions</h1>
        <p className="t-footnote mt-0.5 text-label-2">
          {overview ? `${overview.total_workers} 路 worker · ${overview.active_workers} 运行中` : "读取中…"}
        </p>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {live.length > 0 && (
          <>
            <div className="group-header px-3 pt-2 pb-1">运行中</div>
            {live.map((s) => <Row key={s.id} session={s} active={s.id === selected} onSelect={() => onSelect(s.id)} />)}
          </>
        )}
        <div className="group-header px-3 pt-4 pb-1">全部</div>
        {idle.map((s) => <Row key={s.id} session={s} active={s.id === selected} onSelect={() => onSelect(s.id)} />)}
        {overview && sessions.length === 0 && <p className="t-subhead px-3 py-6 text-label-2">还没有 worker。</p>}
        <div ref={sentinel} className="t-caption py-3 text-center text-label-3">
          {hasMore ? (loadingMore ? "加载中…" : `还有 ${(overview?.total_sessions ?? 0) - sessions.length} 个`) : overview && sessions.length > 0 ? `共 ${sessions.length} 个 session` : ""}
        </div>
      </nav>
      <VersionFooter />
      {overview && (
        <p className="t-caption mono truncate border-t border-separator-soft px-5 py-2.5 text-label-3" title={overview.store}>{overview.store}</p>
      )}
    </aside>
  );
}
