// A command counts as failed when the CLI said so or it exited non-zero.
export function commandFailed(entry) {
  if (!entry) return false;
  if (entry.status === "failed") return true;
  return entry.exit_code !== null && entry.exit_code !== undefined && entry.exit_code !== 0;
}
