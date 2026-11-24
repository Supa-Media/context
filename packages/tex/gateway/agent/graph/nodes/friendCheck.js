/**
 * The Friend check node (`../../friendCheck.js`; `docs/decisions/texting-assistant/member-cards.md`), on the shelf until
 * a Lab draft wires `answerCheck -> friendCheck` (`uses`). The Answer check asks it about a draft its code checks let
 * through, once per draft, on a group's turn that read a member card (`t.memberCards`). The words come from the turn, so
 * its row in the chat's record carries lengths and the verdict only; a send-back's notice waits on the turn
 * (`t.friendNotice`). One small built-in model call; a failure or a late answer lets the draft go.
 *
 * Input `{ draftChars }`. Output `{ to: "pass" | "back" | "skipped", ms }`.
 */
import { chatLinesOf, friendNotice, friendQuestion, readFriendVerdict } from "../../friendCheck.js";
import { cardAsker } from "./groupCard.js";

const DEFAULT_MS = 4_000;
const noTools = async () => ({ isError: true, content: [{ type: "text", text: "No tools here." }] });

export async function friendCheckNode(_input, io) {
  const started = Date.now();
  const t = io?.ctx?.turn ?? null;
  const cards = t?.memberCards?.cards ?? [];
  const draft = t?.drafts?.waiting?.draft;
  if (t === null || cards.length === 0 || typeof draft !== "string" || draft.trim() === "") return { to: "skipped", ms: 0 };
  let timer;
  try {
    const ask = cardAsker({ env: t.env, controlPlane: t.controlPlane, session: t.session });
    const answer = await Promise.race([
      ask(friendQuestion({ draft, cards, chat: chatLinesOf(t.history) }), noTools).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), DEFAULT_MS);
      }),
    ]);
    const verdict = readFriendVerdict(answer);
    if (verdict.to === "back") t.friendNotice = friendNotice(verdict.why);
    return { to: verdict.to, ms: Date.now() - started };
  } catch {
    return { to: "pass", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
