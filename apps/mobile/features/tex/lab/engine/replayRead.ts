/**
 * What Replay reads of a chat's ledger (`views/mine/useMine.ts`), named once so the gateway's `tex_dev` reads the same
 * (`replayEntry.ts`): the conversation's lines with no job's work, and, for the moments shown, every step, judging,
 * tool call and thought; a background job's whole work by its id.
 */
import type { LedgerEntry, LedgerKind } from "../../page/texPageTypes";
import { chatLines, myTexts, type ChatLine, type MyText } from "./mine";

/** The conversation: texts, replies and the notes of what Tex texted on its own; read with `jobs: false`. */
export const LINE_KINDS: LedgerKind[] = ["text", "reply", "note"];
/** Everything a turn's steps logged beyond its texts and reply: what the panel shows each step got and gave. */
export const DETAIL_KINDS: LedgerKind[] = ["step", "judge", "tool", "thinking", "said", "brief", "advisor", "mail_check", "job"];
/** One background job's work, read through the ledger's job filter. */
export const JOB_KINDS: LedgerKind[] = [...DETAIL_KINDS, "reply"];

/** The chat as Replay's left column shows it, from the lines read: the person's texts, then every line in order. */
export function linesOf(seen: LedgerEntry[], group: boolean): { texts: MyText[]; lines: ChatLine[] } {
  const texts = myTexts(seen);
  return { texts, lines: chatLines(seen, texts, { group }) };
}
