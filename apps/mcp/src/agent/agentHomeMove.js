/**
 * The one move of a workspace's old Tex bookkeeping from its bucket into its
 * Tex object (the owner, 2026-11-01; `history.js`, `store/texRouting.js`).
 *
 * Run by the migration (`apps/convex/functions/texHistoryMigration.ts`) for
 * every workspace, before anyone's next text, so no texted turn ever has to:
 *
 * - The history: the old exchange log (or the whole file before it) becomes
 *   the person's one record, written only where none is yet
 *   (`moveHistoryIn`). A workspace with no old history gets no record here.
 * - The turn records (`.context/agent/turns/<turn>.json`, `{clean}`): copied
 *   so a turn shown an event of a turn before the move still finds its
 *   record. A record only moves toward not clean (`loggedTurn.js`): a
 *   `clean: false` is always written, a `clean: true` only where none is.
 * - Running, cancel and steer marks live seconds to minutes: not moved.
 *
 * Nothing in the bucket is deleted (kept three days as the way back).
 * Answers counts only, never a key or a word.
 */

import { HISTORY } from "./conversation.js";
import { moveHistoryIn } from "./history.js";

const TURNS = ".context/agent/turns/";
const TURN_FILE = /^\.context\/agent\/turns\/[A-Za-z0-9_-]{8,64}\.json$/;
const MAX_TURNS = 2_000;

/** `{history: "moved"|"already"|"none"|"would", turns: {copied, kept, would}}`. */
export async function moveAgentHome(store, { dryRun = false, log = () => {} } = {}) {
  const bucket = store?.agentHomeBucket;
  if (!bucket || typeof bucket.list !== "function") throw new Error("not a store with a Tex object beside its bucket");
  const moved = await moveHistoryIn(store, { ...HISTORY, dryRun, onlyIfAny: true, log });
  const history = moved.already ? "already" : moved.moved ? "moved" : moved.would ? "would" : "none";

  const turns = { copied: 0, kept: 0, would: 0 };
  let cursor;
  let seen = 0;
  do {
    const page = await bucket.list({ prefix: TURNS, ...(cursor ? { cursor } : {}) });
    for (const object of page?.objects ?? []) {
      if (!TURN_FILE.test(object.key) || (seen += 1) > MAX_TURNS) continue;
      const read = await bucket.get(object.key);
      if (!read) continue;
      let clean;
      try {
        clean = JSON.parse(await read.text())?.clean;
      } catch {
        clean = undefined;
      }
      // An unreadable record is no record: the object answers "none", which is untrusted, as the bucket's would be.
      if (typeof clean !== "boolean") continue;
      if (dryRun) {
        turns.would += 1;
        continue;
      }
      const body = JSON.stringify({ clean });
      const written = clean === false ? await store.put(object.key, body) : await store.put(object.key, body, { onlyIf: { absent: true } });
      if (written === null) turns.kept += 1;
      else turns.copied += 1;
    }
    cursor = page?.truncated ? page.cursor : undefined;
  } while (cursor && seen <= MAX_TURNS);
  return { history, turns };
}
