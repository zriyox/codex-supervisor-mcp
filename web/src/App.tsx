import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useOverview, useSession } from "./api";
import { SessionRail } from "./components/SessionRail";
import { SessionBoard } from "./components/SessionBoard";
import { WorkerDrawer } from "./components/WorkerDrawer";
import { HoverProvider } from "./components/HoverCard";

// Location lives in the hash so a worker can be linked and the page stays a
// single static file: #/s/<session>  or  #/s/<session>/w/<worker>
function readHash(): { session: string | null; worker: string | null } {
  const m = window.location.hash.match(/^#\/s\/([^/]+)(?:\/w\/([^/]+))?/);
  return { session: m?.[1] ? decodeURIComponent(m[1]) : null, worker: m?.[2] ? decodeURIComponent(m[2]) : null };
}

function writeHash(session: string | null, worker: string | null) {
  const next = session ? `#/s/${encodeURIComponent(session)}${worker ? `/w/${encodeURIComponent(worker)}` : ""}` : "";
  if (window.location.hash !== next) window.history.pushState(null, "", next || window.location.pathname);
}

export function App() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const sync = () => setRoute(readHash());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const { data: overview, error: overviewError } = useOverview();
  // No session chosen: open the one with live workers, else the most recent.
  const sessionId = route.session ?? overview?.sessions[0]?.id ?? null;
  const { data: session, error: sessionError } = useSession(sessionId);

  const go = useCallback((s: string | null, w: string | null) => {
    writeHash(s, w);
    setRoute({ session: s, worker: w });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && route.worker) go(route.session, null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, go]);

  const drawerOpen = route.worker !== null;

  return (
    <HoverProvider>
    <div
      className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] transition-[grid-template-columns] duration-300 md:grid-cols-[280px_minmax(0,1fr)_var(--drawer)]"
      style={{ ["--drawer" as string]: drawerOpen ? "minmax(480px, 42%)" : "0px" }}
    >
      <SessionRail overview={overview} selected={sessionId} onSelect={(id) => go(id, null)} />
      <main className="min-h-0 min-w-0">
        {overviewError && <p className="t-subhead p-8 text-red">读不到后端：{overviewError.message}。确认 codex-supervisor-web 在运行。</p>}
        {!overviewError && !session && !sessionError && <p className="t-subhead p-8 text-label-2">{overview ? "选一个 session。" : "读取中…"}</p>}
        {sessionError && <p className="t-subhead p-8 text-red">读取 session 失败：{sessionError.message}</p>}
        {session && <SessionBoard session={session} selectedWorker={route.worker} onSelectWorker={(id) => go(sessionId, id)} />}
      </main>
      <div className={`min-h-0 overflow-hidden ${drawerOpen ? "" : "hidden md:block"}`}>
        <AnimatePresence>
          {drawerOpen && route.worker && (
            <WorkerDrawer key={route.worker} workerId={route.worker} onClose={() => go(sessionId, null)} onOpenWorker={(id) => go(sessionId, id)} />
          )}
        </AnimatePresence>
      </div>
    </div>
    </HoverProvider>
  );
}
