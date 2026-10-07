import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

export type Status = "queued" | "running" | "completed" | "failed" | "cancelled" | "lost";
export type Phase = "starting" | "thinking" | "command" | "editing" | "reporting" | null;

export interface NowLine {
  id: string;
  title: string;
  phase: Phase;
  current_action: string | null;
}

export interface SessionSummary {
  id: string;
  unsessioned: boolean;
  title: string | null;
  note: string | null;
  title_derived: boolean;
  worker_count: number;
  active_count: number;
  counts: Partial<Record<Status, number>>;
  project_roots: string[];
  first_created_at: string | null;
  last_activity_at: string | null;
  now: NowLine[];
  last_report: { id: string; title: string; text: string; at: string | null } | null;
}

export interface Overview {
  generated_at: string;
  store: string;
  total_workers: number;
  active_workers: number;
  total_sessions: number;
  offset: number;
  limit: number;
  has_more: boolean;
  sessions: SessionSummary[];
}

export interface WorkerRow {
  id: string;
  title: string;
  status: Status;
  phase: Phase;
  session_id: string | null;
  thread_id: string | null;
  goal: string | null;
  goal_status: string | null;
  model: string | null;
  sandbox: string;
  project_root: string;
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  owned_paths: string[];
  depends_on: string[];
  followup_of: string | null;
  resumed_from: string | null;
  run_count: number;
  current_action: string | null;
  last_message: string | null;
  changed_file_count: number;
  command_count: number;
  error: string | null;
  exit_code: number | null;
  pid: number | null;
  created_at: string | null;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface SessionDetail extends SessionSummary {
  offset: number;
  limit: number;
  has_more: boolean;
  workers: WorkerRow[];
}

export interface CommandEntry {
  command: string | null;
  exit_code: number | null;
  status: string;
  completed_at: string;
}

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  turns: number;
}

export interface WorkerDetail extends WorkerRow {
  prompt: string | null;
  changed_files: string[];
  commands: CommandEntry[];
  reports: string[];
  native_goal: Record<string, unknown> | null;
  usage: Usage;
  notices: string | null;
  run_log: string | null;
  event_kinds: { kind: string; count: number }[];
}

export interface RawEvent {
  type: string;
  item?: { type?: string; command?: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface VersionCheck {
  checked_at: string;
  source: "registry" | "cache" | "stale-cache" | "offline" | "disabled";
  error: string | null;
  installed: { version: string; integrity: string | null; commit: string | null; source: string; path: string };
  latest: { version: string; integrity: string | null; shasum: string | null; published_at: string | null } | null;
  update_available: boolean;
  integrity_matches: boolean | null;
  install_command: string;
  notice: string | null;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return (await response.json()) as T;
}

const LIVE_MS = 2500;
const IDLE_MS = 8000;

export function useVersion() {
  return useQuery({
    queryKey: ["version"],
    queryFn: () => get<VersionCheck>("/api/version"),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000
  });
}

const SESSION_PAGE = 20;
const WORKER_PAGE = 40;

// Lists load a page at a time; the rail and the ledger ask for the next page
// when their last row scrolls into view. Polling refetches every loaded
// page, so a running batch keeps updating without resetting the scroll.
export function useOverview() {
  return useInfiniteQuery({
    queryKey: ["overview"],
    queryFn: ({ pageParam }) => get<Overview>(`/api/overview?limit=${SESSION_PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more ? last.offset + last.limit : undefined),
    refetchInterval: (query) => ((query.state.data?.pages[0]?.active_workers ?? 0) > 0 ? LIVE_MS : IDLE_MS)
  });
}

export function useSession(id: string | null) {
  return useInfiniteQuery({
    queryKey: ["session", id],
    queryFn: ({ pageParam }) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id!)}?limit=${WORKER_PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more ? last.offset + last.limit : undefined),
    enabled: id !== null,
    refetchInterval: (query) => ((query.state.data?.pages[0]?.active_count ?? 0) > 0 ? LIVE_MS : IDLE_MS)
  });
}

export function useWorker(id: string | null) {
  return useQuery({
    queryKey: ["worker", id],
    queryFn: () => get<WorkerDetail>(`/api/workers/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "queued" ? LIVE_MS : false;
    }
  });
}

export function useEvents(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["events", id],
    queryFn: () => get<{ task_id: string; events: RawEvent[] }>(`/api/workers/${encodeURIComponent(id!)}/events?limit=400`),
    enabled: id !== null && enabled,
    refetchInterval: 4000
  });
}
