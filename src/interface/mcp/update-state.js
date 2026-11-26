import { maybeAutoUpdate } from "../../infra/update/auto-update.js";
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
export async function refreshUpdateState({ force = false } = {}) {
  try {
    updateState = await checkForUpdate({ force });
    autoUpdateState = await maybeAutoUpdate(updateState);
    const notice = updateNotice(updateState, autoUpdateState)?.notice;
    if (notice) process.stderr.write(`[agent-supervisor] ${notice}\n`);
  } catch (error) {
    process.stderr.write(`[agent-supervisor] update check failed: ${error.message}\n`);
  }
  return updateState;
}

// The short form for tool results: null when the install is current.
export function updateField() {
  return updateNotice(updateState, autoUpdateState);
}

// Spread into a result: adds `update` only when there is something to say.
export function withUpdate(payload) {
  const update = updateField();
  return update ? { ...payload, update } : payload;
}
