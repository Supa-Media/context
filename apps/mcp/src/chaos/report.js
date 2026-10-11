/**
 * What a write tells the agent that made it about the chaos score.
 *
 * The owner's ask (2026-10-10): "as notes are written and moved we can
 * immediately return the chaos score changes so agents can see how they are
 * improving or hurting the chaos". So `write_note`, `move_note`,
 * `move_notes`, `move_folder` and `archive_note` end with the score before
 * and after and the folders the change touched. No new tool: installed
 * clients cache tool lists, so a capability arrives on the tools they have
 * (`docs/decisions/gateway-protocol.md`).
 *
 * The rescore itself starts in `recordChange` (`tree/record.js`); this file
 * waits for it, briefly, and words it. A rescore slower than `WAIT_MS` is
 * left to finish behind the response and the answer says nothing about it,
 * rather than holding the agent up.
 */

import { chaosWord, folderChaos } from "./rubric.js";

/** Tools whose answers carry the score. */
export const CHAOS_TOOLS = new Set(["write_note", "move_note", "move_notes", "move_folder", "archive_note"]);

/** How long an answer waits for its rescore. */
export const WAIT_MS = 3000;

const pending = new WeakMap();

/** Remember the rescore a change started on this store, for the answer to report. */
export function rememberChaos(store, promise) {
  if (store && typeof store === "object" && promise && typeof promise.then === "function") pending.set(store, promise);
}

/** Take (and forget) the rescore a change started on this store, or undefined. */
export function takeChaos(store) {
  if (!store || typeof store !== "object") return undefined;
  const promise = pending.get(store);
  pending.delete(store);
  return promise;
}

/** Wait at most `ms` for `promise`, answering null after that or on failure. */
export async function within(promise, ms = WAIT_MS) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whole numbers: the verdict says when a change is smaller than one. */
function shown(score) {
  return Math.round(score);
}

function verdictOf(before, after) {
  const delta = after - before;
  if (Math.abs(delta) < 0.05) return "no change";
  const small = shown(before) === shown(after);
  if (delta > 0) return small ? "a little messier" : "messier";
  return small ? "a little calmer" : "calmer";
}

/** What a folder's item count means, in a few words an agent can act on. */
function folderHint(items, chaos) {
  if (items < 4 && chaos > 0) return items === 0 ? "only its about note" : "thin: calm is 4 to 5";
  if (items <= 5) return "calm";
  if (items <= 10) return "fine";
  return `${chaosWord(folderChaos(items))}: calm is 4 to 5, 10 is average`;
}

/**
 * The lines an answer ends with, or "" when there is nothing to say.
 *
 * @param {{ before: { all: number, team: number }, after: { all: number, team: number }, folders: { folder: string, before: object | null, after: object | null }[] } | null} report
 * @param {"all" | "team"} audience who is reading: `all` for a private connection
 */
export function chaosLines(report, audience) {
  if (!report || !report.before || !report.after) return "";
  const team = audience === "team";
  const before = team ? report.before.team : report.before.all;
  const after = team ? report.after.team : report.after.all;
  const lines = [`chaos: ${shown(before)} → ${shown(after)} of 100 (${verdictOf(before, after)}; lower is calmer)`];
  const itemsOf = (row) => {
    if (!row) return 0;
    if (team) return Number(row.team_exists) === 1 ? Number(row.team_items) : null;
    return Number(row.items);
  };
  const chaosOf = (row) => {
    if (!row) return 0;
    const weight = Number(team ? row.team_weight : row.weight);
    return weight > 0 ? Number(team ? row.team_sum : row.sum) / weight : 0;
  };
  const shownFolders = [];
  for (const entry of report.folders ?? []) {
    const was = itemsOf(entry.before);
    const now = itemsOf(entry.after);
    // A team reader is never told about a folder with nothing they can open in it.
    if (was === null || now === null) continue;
    if (entry.after === null && entry.before === null) continue;
    const name = entry.folder === "" ? "(top level)" : entry.folder;
    if (entry.after === null) {
      shownFolders.push(`  ${name}: gone`);
      continue;
    }
    const counts = was === now ? `${now} items` : `${was} → ${now} items`;
    shownFolders.push(`  ${name}: ${counts} (${folderHint(now, chaosOf(entry.after))})`);
  }
  lines.push(...shownFolders.slice(0, 4));
  return lines.join("\n");
}

/** `result` with the score's lines added to its text, or unchanged. */
export function withChaosLines(result, text) {
  if (!text || !result || result.isError || !Array.isArray(result.content)) return result;
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const content = [{ ...first, text: `${first.text}\n${text}` }, ...result.content.slice(1)];
  const next = { ...result, content };
  // Keep whatever the handler hid on the result (`live/activityHint.js`).
  for (const symbol of Object.getOwnPropertySymbols(result)) {
    Object.defineProperty(next, symbol, { value: result[symbol], enumerable: false });
  }
  return next;
}
