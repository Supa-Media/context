/**
 * Telling an open editor where its note went, after a keyed row move
 * (`docs/decisions/storage-and-credentials/paths-on-read.md`).
 *
 * The control plane has already moved the rows. A note's collaboration history
 * is filed by its note id (`packages/collaboration/src/address.js`), and since
 * the backfill filed every older head (`functions/collaborationFiling.ts`)
 * nothing is carried: a move leaves the history where it is, and the note's
 * new name finds it.
 *
 * What is left is the rooms: a move of up to `ANNOUNCE_MOVES_MAX` notes tells
 * each old name's room where the note went (`announceMovedToPresence`), so an
 * open editor follows at once; a bigger move's rooms learn it when they
 * reconnect, and an editor's update sent to the old name is forwarded to where
 * the note is now (`collaborationRoute.js`). The new name is sent only where
 * the team tier may see it: a room holds people who could see the old name,
 * not necessarily the new one, and a move can narrow.
 */

import { supported as collaborationSupported } from "@context/collaboration";
import { canSee } from "../privacy/engine.js";
import { announceMovedToPresence } from "../live/presence.js";

/**
 * Moves this small tell each moved note's room where it went. A room is a request each, and a folder of
 * any size must stay one row change.
 */
export const ANNOUNCE_MOVES_MAX = 50;

/** How many rooms are told at once. */
const ANNOUNCE_LANES = 10;

/**
 * Tell each moved note's room where it went.
 *
 * @param {object} store the request's store
 * @param {{from: string, to: string}[]} moved the files the row move renamed
 * @param {{rules: unknown, overrides: unknown}} privacy the rules the move was judged under; without them no name is shared
 * @returns {Promise<{announced: number}>}
 */
export async function announceMoves(store, moved, privacy) {
  const answer = { announced: 0 };
  if (!collaborationSupported(store) || !Array.isArray(moved) || moved.length > ANNOUNCE_MOVES_MAX) return answer;
  const notes = moved.filter(
    (pair) => typeof pair?.from === "string" && typeof pair?.to === "string" && pair.from.endsWith(".md") && pair.to.endsWith(".md"),
  );
  // A room each, several at a time: one after another, a batch of 20 waited on 20 requests in turn.
  for (let start = 0; start < notes.length; start += ANNOUNCE_LANES) {
    await Promise.all(notes.slice(start, start + ANNOUNCE_LANES).map(async (pair) => {
      // Shown to the room only where every team member may see the new name; otherwise members are told it moved, not where.
      const shownTo = privacy && canSee(pair.to, "team", privacy.rules, privacy.overrides) ? pair.to : null;
      await announceMovedToPresence(store, pair.from, shownTo).catch(() => {});
      answer.announced += 1;
    }));
  }
  return answer;
}
