// When a worker's worktree may be removed.
//
// The worker's branch is never deleted, so commits are never at risk. The only
// thing a removal can lose is uncommitted edits, and those are saved as a
// checkpoint commit on the branch first. What the policy protects is therefore
// convenience, not data: work that has not landed keeps its worktree for a
// while so it can still be inspected, resumed and landed in place.

export const DEFAULT_HOLD_DAYS = 7;

export function holdMsFrom(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_HOLD_DAYS * 86400000;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days * 86400000 : DEFAULT_HOLD_DAYS * 86400000;
}

const verdict = (value, reasons, extra = {}) => ({ verdict: value, reasons, checkpoint: false, eligible_after: null, ...extra });

// facts: { active, dependent, terminal, identity, landed, uncommitted, unlandedCommits, finishedAt }
//   active / identity are a reason string or null; finishedAt is epoch ms or null.
export function cleanupVerdict(facts, { now, holdMs }) {
  if (facts.active) return verdict("blocked", [facts.active]);
  if (facts.dependent) return verdict("blocked", ["an active dependent still needs this work"]);
  if (!facts.terminal) return verdict("blocked", ["worker has not finished"]);
  if (facts.identity) return verdict("review", [facts.identity]);

  const unlanded = !facts.landed && facts.unlandedCommits > 0;
  if (facts.uncommitted === 0 && !unlanded) {
    return verdict("safe", facts.landed ? ["landed on the target branch", "worktree clean"] : ["no changes to keep"]);
  }
  const what = [
    unlanded ? `${facts.unlandedCommits} commit(s) not landed` : null,
    facts.uncommitted > 0 ? `${facts.uncommitted} uncommitted path(s)` : null
  ].filter(Boolean).join(", ");
  const eligibleAt = (facts.finishedAt ?? now) + holdMs;
  const eligibleAfter = new Date(eligibleAt).toISOString();
  if (now < eligibleAt) {
    return verdict("review", [`${what}; kept until ${eligibleAfter}, then saved on the worker branch and removed`], { eligible_after: eligibleAfter });
  }
  return verdict("safe", [`${what}; the hold period is over`, "everything is kept on the worker branch"], {
    checkpoint: facts.uncommitted > 0,
    eligible_after: eligibleAfter
  });
}
