/**
 * The cache rules' freeze (Dev2, 2026-11-20: "until the next summary, the tools, system prompt and first message stay
 * byte-identical"). A step set to `freeze: "summary"` (`texConfig.js` `texFreeze`) sends its rarely-changing modules
 * (`FROZEN_MODULES`) with the words they had at the chat's first turn of the day, kept in the chat's own home
 * (`texStore/frozen.js`), so a mid-day edit to About me or the group's playbook no longer rewrites the cached history
 * after it. What changed since is said after the history (`turnPrompt.js` `frozenNote`), and wins. The day turns with
 * the chat's summaries (a day in the person's time zone, `weekHistory.js`), and the next day's first turn freezes anew.
 *
 * A turn with no home to keep them in (the app, a shared workspace's own connection) reads every module each turn.
 * Never throws: a store that fails leaves the turn reading them as before.
 */
import { dayOf } from "./jobLog.js";
import { FROZEN_MODULES } from "./frozenModuleNames.js";
import { deskFrozen } from "./history.js";
import { ledgerPlace, ONE_TO_ONE_CHAT } from "./ledger.js";

/** The day a chat's summaries are written for, the history's own (`weekHistory.js` `weekStart`): the date where the person is. */
export function summaryDay(now, timeZone) {
  return dayOf(now, timeZone || "UTC");
}

/**
 * The freeze for one turn of `step`, or null when the step reads each turn or the chat keeps no home:
 * `{ day, modules, see(current) }`. `modules` is the day's words (null on the day's first turn); `see` is told the
 * words the turn built and, the first time with none kept, holds them for the day; `keep()` writes them to the chat's
 * home once the model has answered (`runTheModel.js`), so the write is never one more call the person waits on.
 */
export async function frozenModules({ store, session, step, freeze, now = Date.now(), timeZone = null, log = (line) => console.log(JSON.stringify(line)) }) {
  if (freeze !== "summary") return null;
  const place = ledgerPlace(session);
  const home = place === null || typeof store?.texLedger !== "function" ? null : store.texLedger(place.owner.chat ?? null);
  if (home === null || typeof home?.frozenOf !== "function" || typeof home.keepFrozen !== "function") return null;
  const day = summaryDay(now, timeZone);
  // The one-to-one chat's come with its history in the desk call (`texStore/desk.js`); a group's, or an older object's, by their own.
  const fromDesk = place.chat === ONE_TO_ONE_CHAT ? await deskFrozen(store, step) : undefined;
  const kept = fromDesk !== undefined ? fromDesk : await Promise.resolve(home.frozenOf(place.chat, step)).catch(() => null);
  const state = { day, modules: kept?.day === day ? kept.modules : null, held: null, saving: null };
  state.see = (current) => {
    if (state.modules !== null) return;
    const modules = {};
    for (const id of FROZEN_MODULES) modules[id] = typeof current?.[id] === "string" ? current[id] : "";
    state.modules = modules; // every later round of this turn sends the same words
    state.held = { day, modules };
    log({ event: "modules_frozen", step, day, sizes: Object.fromEntries(Object.entries(modules).map(([id, words]) => [id, words.length])) });
  };
  // Writes the day's words the turn held, once; a turn that froze nothing new writes nothing.
  state.keep = () => {
    if (state.held === null || state.saving !== null) return state.saving ?? Promise.resolve();
    state.saving = Promise.resolve(home.keepFrozen(place.chat, step, state.held)).catch(() => {});
    return state.saving;
  };
  return state;
}
