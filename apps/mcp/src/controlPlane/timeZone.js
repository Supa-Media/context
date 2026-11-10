/**
 * A workspace owner's time zone, which the gateway writes a note's date properties in (`notes/dateStamp.js`; Dev2,
 * 2026-11-10). Asked with the person's own token (`/gateway/time-zone`), and kept here a few minutes per workspace so
 * a person typing does not cost a control-plane call per pause.
 */

/** How long one answer is kept. A zone changes when somebody travels, not between two saves. */
export const TIME_ZONE_TTL_MS = 10 * 60_000;
/** Workspaces one isolate keeps an answer for. */
const KEPT = 500;
const ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

const kept = new Map();

/** Forget every kept answer (tests). */
export function forgetTimeZones() {
  kept.clear();
}

export function createTimeZoneMethods({ post }) {
  return {
    /** The zone of `workspaceId`'s owner, or null: none set, a token that does not reach it, or a failure. */
    async ownerTimeZone(accessToken, workspaceId, now = Date.now()) {
      const held = kept.get(workspaceId);
      if (held && now - held.at < TIME_ZONE_TTL_MS) return held.zone;
      const parsed = await post("/gateway/time-zone", { accessToken, expectedWorkspaceId: workspaceId });
      const zone = typeof parsed?.timeZone === "string" && ZONE.test(parsed.timeZone) ? parsed.timeZone : null;
      if (kept.size >= KEPT) kept.delete(kept.keys().next().value);
      kept.set(workspaceId, { zone, at: now });
      return zone;
    },
  };
}
