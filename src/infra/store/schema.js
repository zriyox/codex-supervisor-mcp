// Columns added after v1. Kept in one place so the legacy rebuild and the
// fresh CREATE TABLE cannot drift apart.
export const POST_V1_COLUMNS = [
  ["run_host_pid", "INTEGER"],
  ["attention_reason", "TEXT"],
  ["run_evidence", "TEXT"],
  ["guard_policy", "TEXT"],
  ["input_context", "TEXT"],
  ["resumed_from", "TEXT"],
  ["thread_id", "TEXT"],
  ["owned_paths", "TEXT NOT NULL DEFAULT '[]'"],
  ["depends_on", "TEXT NOT NULL DEFAULT '[]'"],
  ["goal_objective", "TEXT"],
  ["goal_token_budget", "INTEGER"],
  ["goal_status", "TEXT"],
  ["goal_tokens_used", "INTEGER"],
  ["goal_time_used_seconds", "INTEGER"],
  ["goal_updated_at", "TEXT"],
  ["run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["cancel_requested_at", "TEXT"],
  ["notices", "TEXT"],
  ["session_id", "TEXT"],
  ["base_commit", "TEXT"],
  ["acceptance", "TEXT"],
  ["acceptance_local", "TEXT"],
  ["session_policy_revision", "INTEGER"],
  ["acceptance_timeout_ms", "INTEGER"],
  ["acceptance_results", "TEXT"],
  ["landed_at", "TEXT"],
  ["landed_head", "TEXT"],
  ["landed_branch", "TEXT"],
  ["push_verified_at", "TEXT"],
  ["push_remote", "TEXT"],
  ["push_branch", "TEXT"],
  ["push_remote_head", "TEXT"]
];

export const TASK_EXTRA_COLUMNS = [
  ["workspace_kind", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["workspace_metadata", "TEXT"]
];

export const TASKS_DDL = `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      worker TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      cwd TEXT NOT NULL,
      project_root TEXT NOT NULL,
      workspace_kind TEXT NOT NULL DEFAULT 'legacy',
      workspace_metadata TEXT,
      sandbox TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT NOT NULL DEFAULT 'high',
      skip_git_repo_check INTEGER NOT NULL DEFAULT 1,
      prompt TEXT NOT NULL,
      changed_files TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      pid INTEGER,
      run_host_pid INTEGER,
      attention_reason TEXT,
      run_evidence TEXT,
      guard_policy TEXT,
      input_context TEXT,
      exit_code INTEGER,
      signal TEXT,
      stderr_tail TEXT,
      last_event_at TEXT,
      last_event_type TEXT,
      last_message TEXT,
      current_action TEXT,
      current_command TEXT,
      error TEXT,
      followup_of TEXT,
      resumed_from TEXT,
      session_id TEXT,
      thread_id TEXT,
      owned_paths TEXT NOT NULL DEFAULT '[]',
      depends_on TEXT NOT NULL DEFAULT '[]',
      goal_objective TEXT,
      goal_token_budget INTEGER,
      goal_status TEXT,
      goal_tokens_used INTEGER,
      goal_time_used_seconds INTEGER,
      goal_updated_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested_at TEXT,
      notices TEXT,
      worktree_path TEXT,
      base_commit TEXT,
      acceptance TEXT,
      acceptance_local TEXT,
      session_policy_revision INTEGER,
      acceptance_timeout_ms INTEGER,
      acceptance_results TEXT,
      landed_at TEXT,
      landed_head TEXT,
      landed_branch TEXT,
      push_verified_at TEXT,
      push_remote TEXT,
      push_branch TEXT,
      push_remote_head TEXT,
      run_log TEXT NOT NULL
    );
`;

export const TASK_COLUMNS = [
  "id", "title", "worker", "status", "phase", "cwd", "project_root", "workspace_kind", "workspace_metadata", "sandbox", "model",
  "reasoning_effort", "skip_git_repo_check", "prompt", "changed_files", "commands",
  "created_at", "updated_at", "started_at", "completed_at", "pid", "run_host_pid", "attention_reason", "run_evidence", "guard_policy", "input_context", "exit_code", "signal",
  "stderr_tail", "last_event_at", "last_event_type", "last_message", "current_action",
  "current_command", "error", "followup_of", "resumed_from", "session_id", "thread_id", "owned_paths",
  "depends_on", "goal_objective", "goal_token_budget", "goal_status", "goal_tokens_used",
  "goal_time_used_seconds", "goal_updated_at", "run_count", "cancel_requested_at",
  "notices", "worktree_path", "base_commit", "acceptance", "acceptance_local", "session_policy_revision", "acceptance_timeout_ms", "acceptance_results", "landed_at", "landed_head", "landed_branch", "push_verified_at", "push_remote", "push_branch", "push_remote_head", "run_log"
];

export const TASK_EVENTS_DDL = `
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_id TEXT,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'legacy',
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_sha256 TEXT
    );
  `;

export const TASK_EVENTS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);";

export const TASKS_SESSION_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);";

export const CONTROL_DDL = `
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      canonical_remote TEXT,
      root TEXT NOT NULL UNIQUE,
      default_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      parent_work_item_id TEXT,
      objective TEXT,
      owner TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_repo ON work_items(repo_id, created_at);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      codex_thread_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      base_sha TEXT,
      run_status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(task_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_work_item ON runs(work_item_id, attempt);
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      state TEXT NOT NULL,
      source_event_id INTEGER,
      source_artifact_id TEXT,
      valid_for_sha TEXT,
      valid_for_content_hash TEXT,
      valid_for_manifest_hash TEXT,
      watched_paths TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      supersedes_id TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      verified_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_id, state);
    CREATE INDEX IF NOT EXISTS idx_facts_supersedes ON facts(supersedes_id, state);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      uri TEXT NOT NULL,
      sha256 TEXT,
      security_class TEXT NOT NULL DEFAULT 'internal',
      retention TEXT NOT NULL DEFAULT 'permanent',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at);
    CREATE TABLE IF NOT EXISTS review_findings (
      id TEXT PRIMARY KEY,
      subject_task_id TEXT NOT NULL,
      verifier_task_id TEXT NOT NULL UNIQUE,
      subject_run_id TEXT,
      subject_base_sha TEXT,
      subject_fingerprint TEXT,
      status TEXT NOT NULL,
      verdict TEXT,
      reason TEXT,
      evidence_artifact_id TEXT,
      finding_event_id INTEGER,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_findings_subject ON review_findings(subject_task_id, created_at);
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      fact_versions TEXT NOT NULL DEFAULT '[]',
      base_sha TEXT,
      prompt_sha256 TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      excluded_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_run ON context_snapshots(run_id, created_at);
    CREATE TABLE IF NOT EXISTS cleanup_plans (
      id TEXT PRIMARY KEY,
      project_root TEXT,
      generated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      policy TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cleanup_plan_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      fingerprint TEXT,
      reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
      eligible_after TEXT,
      applied_at TEXT,
      applied_by TEXT,
      UNIQUE(plan_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cleanup_plan_items_plan ON cleanup_plan_items(plan_id, verdict);
    CREATE INDEX IF NOT EXISTS idx_cleanup_plan_items_task ON cleanup_plan_items(task_id, applied_at);
  `;

// A session is a string on each task row; this table is what a session is
// *about*. A main thread sets it once per batch, so a reader sees "给 12
// 个接口补单测" instead of a bare id.
export const SESSIONS_DDL = `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

// Side questions asked from the board. One side session per worker (the
// forked Codex thread), many turns under it. A turn keeps the stream chunks
// it produced, so a page that comes back can replay what it missed and the
// conversation survives a board restart.
export const SIDE_DDL = `
    CREATE TABLE IF NOT EXISTS side_sessions (
      task_id TEXT PRIMARY KEY,
      fork_thread_id TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      worker_run_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS side_turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      chunks TEXT NOT NULL DEFAULT '[]',
      usage TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_side_turns_task ON side_turns(task_id, started_at);
  `;
