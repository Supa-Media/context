/**
 * One change at a time in a group chat (Dev2, 2026-11-13, one turn per text):
 * a chat's turns run side by side, and a tool that changes something (a note
 * written, a mail sent, a calendar change, a job started) takes this chat's
 * write lock for the length of that one call. Reads never take it.
 *
 * Held in the chat's own Tex store object, in memory only: the object is the
 * one place every turn of the chat reaches, and a lock lost when the object
 * is evicted only drops an ordering aid, never a write. A lock is leased
 * (`LOCK_LEASE_MS`), so a turn that died holding it holds nothing for long.
 *
 * `before` names the other turn's change that the lock waited for (its tool
 * and when), so the next turn is told to reread before it changes the same
 * thing (`agent/chatWriteLock.js`).
 */

/** How long one held lock lasts at most: a tool call longer than this is not waited for. */
export const LOCK_LEASE_MS = 60_000;
/** Another turn's change this recent is named to the turn that takes the lock next. */
export const RECENT_CHANGE_MS = 120_000;

export function writeLocks(now = Date.now) {
  let held = null;
  let last = null;
  return {
    /** Take the lock for `turn` (its `tool`): `{ ok: false }` while another turn holds it. */
    take({ turn, tool }) {
      const at = now();
      if (typeof turn !== "string" || turn === "") return { ok: false };
      if (held !== null && held.until > at && held.turn !== turn) return { ok: false };
      held = { turn, tool: String(tool ?? ""), until: at + LOCK_LEASE_MS };
      const before = last !== null && last.turn !== turn && at - last.at < RECENT_CHANGE_MS ? { tool: last.tool, at: last.at } : null;
      return { ok: true, ...(before ? { before } : {}) };
    },
    /** Give it back; only its holder can. */
    give({ turn }) {
      if (held !== null && held.turn === turn) {
        last = { turn, tool: held.tool, at: now() };
        held = null;
      }
      return { ok: true };
    },
  };
}
