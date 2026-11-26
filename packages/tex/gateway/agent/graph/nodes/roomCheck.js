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
 * The first hold a turn sends the asker is recorded in the control plane with who is in the chat, so their yes in their
 * own chat opens it here for those people (`heldShare.js`).
 *
 * Input `{ at: "draft" | "answer", draftChars }`. Output `{ to: "pass" | "hold" | "skipped", read?, chars?, pointed?, carried?,
 * from?, shared?, sent?, recorded? }` (a pass says how it measured, `roomTally`):
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
  const first = t.roomHeld === undefined || t.roomHeld === null;
  const sent = t.roomHeld?.sent === true || holdForAsker(t.ledger, t.group, draft, facts(true));
  // Once a turn, the hold is recorded with who is here, so the asker's yes in their own chat can open it for them
  // (`heldShare.js`, `apps/convex/functions/groupHolds.ts`; rulebook rule 4). Ids and slugs only, never the words.
  const recorded = sent && first ? await recordHold(t, verdict.from) : t.roomHeld?.recorded ?? false;
  t.roomHeld = { from: verdict.from, sent, recorded };
  t.roomNotice = facts(sent);
  if (input?.at === "answer") t.roomHush = true;
  return { to: "hold", read: reads.slugs().length, from: verdict.from.length, shared: verdict.shared, sent, recorded };
}

/** A fresh hold's id. */
export function holdId() {
  return `h${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

async function recordHold(t, slugs) {
  const token = t.session?.accessToken;
  if (typeof t.controlPlane?.groupHold !== "function" || typeof token !== "string") return false;
  const answer = await t.controlPlane.groupHold(token, { id: holdId(), slugs }).catch(() => null);
  return answer?.status === "held";
}
