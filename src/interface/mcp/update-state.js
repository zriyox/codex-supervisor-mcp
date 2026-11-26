import { maybeAutoUpdate } from "../../infra/update/auto-update.js";
import { handoverNotice, maybeHandOver } from "../../infra/update/handover.js";
import { checkForUpdate, updateNotice } from "../../infra/update/update-check.js";

// Nobody should keep running an old build without hearing about it. The
// registry is asked once at start and every six hours after; the answer
// rides along in the overview, the dispatch receipt and the wait response,
// which are the calls every orchestrating session makes.
export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;
export let updateState = null;
// The last word from auto-update.js: null until a check found a newer
// version, then started | running | done | failed | skipped.
export let autoUpdateState = null;
// The package was renamed; handover.js installs the new one. Null until the first check.
export let handoverState = null;
export async function refreshUpdateState({ force = false } = {}) {
  try {
    updateState = await checkForUpdate({ force });
    autoUpdateState = await maybeAutoUpdate(updateState);
    handoverState = await maybeHandOver(updateState);
    if (!updateState.disabled) process.stderr.write(`[codex-supervisor] ${handoverNotice(handoverState).notice}\n`);
  } catch (error) {
    process.stderr.write(`[codex-supervisor] update check failed: ${error.message}\n`);
  }
  return updateState;
}

// The short form for tool results. The rename is always said; a newer release
// of this package is not worth a line beside it.
export function updateField() {
  // With the update check switched off the server says nothing unasked, the rename included.
  if (!updateState || updateState.disabled) return updateNotice(updateState, autoUpdateState);
  return handoverNotice(handoverState);
}

// Spread into a result: adds `update` only when there is something to say.
export function withUpdate(payload) {
  const update = updateField();
  return update ? { ...payload, update } : payload;
}
