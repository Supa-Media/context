/** Starts this turn's egress ledger: what it reads from outside and what it may send out. One step of Tex's turn (`../texEntryPoint.js`). */

import { newLedger } from "../../privacy/egress.js";
import { addressedTo } from "../../tools/offerFor.js";
import { ROUTINES_CLIENT_ID } from "../routine.js";
import { CONSOLE_CLIENT_ID, TEXTS_CLIENT_ID } from "./clients.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function watchWhatLeaves(t) {
  const { group, quoted, routine, runner, session, thumbsUp } = t;
  /*
    THE EGRESS LEDGER FOR THIS TURN. `/agent` sees a turn whole — the
    question is the person's own words and every tool call passes through
    this gateway — so the ledger can say whether it took in anything from
    outside the workspace, and carry the asks it raised (`privacy/egress.js`).
  */
  const ledger = newLedger();
  /*
    "Seen whole" is a claim about who wrote the question, and only the clients
    that are ours can make it: the texting thread's question is the person's
    own message, the app's panel is their own hand, a routine is their own
    note. Any other connected client could put anything in `question`, so its
    turn is held like its tool calls are.
  */
  const firstParty =
    session.actorClientId === TEXTS_CLIENT_ID ||
    session.actorClientId === CONSOLE_CLIENT_ID ||
    session.actorClientId === ROUTINES_CLIENT_ID ||
    group !== null;
  session.egress = {
    complete: firstParty,
    ledger,
    texting: session.actorClientId === TEXTS_CLIENT_ID || group !== null,
    // The routine this run is, for a standing forward only it may use (`tools/forwardRule.js`).
    ...(runner ? { routine: routine.path } : {}),
    // A 👍 on words that were not the armed ask: Tex's own preview, maybe (`tools/likedPreview.js`).
    // In a group, only on words that asked this tagger by name (`tools/offerFor.js`).
    ...(!thumbsUp && (quoted.tapback === "Liked" || quoted.tapback === "Loved") && (group === null || addressedTo(quoted.words, group.from)) ? { liked: quoted.words } : {}),
    ...(group !== null ? { group: { from: group.from, people: group.people } } : {}), // who an email may be offered to (`offerFor.js`)
  };
  Object.assign(t, { ledger });
}
// TEX ENTRY POINT: end
