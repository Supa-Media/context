/**
 * The Room check node (`../../roomCheck.js`; Dev2, 2026-11-26: a permission gate right before send), on the shelf until
 * a Lab draft wires it. Code only, no model.
 *
 * Wired as `answerCheck -> roomCheck` (`uses`), the Answer check asks it about each group draft after its other checks:
 * a draft that carries what this turn (or the job it reports) read from a workspace someone in the room can't open, and
 * the asker didn't point at, is held. Its draft goes to the asker alone, once per turn (`privateAside.js`
 * `holdForAsker`), and the front door is sent back with the facts (`t.roomNotice`) to write what the group gets.
 * Wired as `finish -> roomCheck`, it reads the answer once more before it goes, so a draft that was never checked (a
 * last round) or still carries it is held the same way and nothing goes to the group (`t.roomHush`).
 *
 * Input `{ at: "draft" | "answer", draftChars }`. Output `{ to: "pass" | "hold" | "skipped", read?, chars?, pointed?, carried?,
 * from?, shared?, sent? }` (a pass says how it measured, `roomTally`):
 * counts only, never the words.
 */
import { heldFacts, roomTally, roomVerdict } from "../../roomCheck.js";
import { holdForAsker } from "../../privateAside.js";

export async function roomCheckNode(input, io) {
  const t = io?.ctx?.turn ?? null;
  const reads = t?.roomReads ?? null;
  if (t === null || reads === null || t.group === null || t.group === undefined || t.job) return { to: "skipped" };
  const draft = input?.at === "answer" ? t.turn?.answer : t.drafts?.waiting?.draft;
  const seen = { draft, reads, group: t.group, question: t.question, history: t.history };
  const verdict = roomVerdict(seen);
  if (verdict === null) return { to: "pass", read: reads.slugs().length, ...roomTally(seen) };
  const facts = (sent) => heldFacts(verdict, { asker: t.group.from, sent });
  // The asker gets the first held draft, once a turn; a rewrite that still carries it adds nothing new for them.
  const sent = t.roomHeld?.sent === true || holdForAsker(t.ledger, t.group, draft, facts(true));
  t.roomHeld = { from: verdict.from, sent };
  t.roomNotice = facts(sent);
  if (input?.at === "answer") t.roomHush = true;
  return { to: "hold", read: reads.slugs().length, from: verdict.from.length, shared: verdict.shared, sent };
}
