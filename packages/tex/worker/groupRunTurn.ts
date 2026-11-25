/**
 * Running the group in a turn (`groupRun.ts`): the "(name the chat)" lines of Tex's answer, checked against the message
 * it answers and done on the group's line before the words go, and the one line that tells the chat what could not be.
 */

import type { GroupLine, GroupPlace } from "./groupLine";
import { groupRunOf, type GroupAction, type GroupRefusal } from "./groupRun";
import type { InboundAttachment } from "./inbound";

/** What the chat is told, with no model, when a "running the group" line could not be done. */
export const GROUP_RUN_LINES = {
  addNotTheirs: "I can only add someone by the number or email in your own text. Send it and I'll add them.",
  photoNone: "Send the photo with your text and I'll make it the chat's photo.",
  cannot: "I can't change this chat from the number it's on.",
  failed: "I couldn't change the chat just now. Try again in a minute.",
} as const;

/**
 * What the chat's record keeps of a change Tex made, as Tex's own line: a turn that only ran the group texts nothing,
 * and with nothing kept the next turn read the ask as unanswered and did it again (2026-11-24, a Lab eval: a poll
 * asked after a rename renamed the chat a second time).
 */
export function groupRunDoneWords(action: GroupAction): string {
  if (action.kind === "name") return `(named the chat “${action.name}”)`;
  if (action.kind === "photo") return "(set the chat photo)";
  return `(added ${action.address} to the chat)`;
}

/**
 * The words to text, each with its "running the group" lines taken out (one left empty stays in its place, so each
 * text keeps the message it goes under, and is not sent), and what to tell the chat after.
 */
export async function runTheGroup(
  texts: readonly string[],
  asked: { text: string; attachments?: readonly InboundAttachment[] },
  line: Pick<GroupLine, "runGroup">,
  place: GroupPlace,
): Promise<{ texts: string[]; told: string | null; why: "cannot" | "failed" | "add_not_theirs" | "photo_none" | null; done: GroupAction[] }> {
  const actions: GroupAction[] = [];
  const refused: GroupRefusal[] = [];
  const out: string[] = [];
  for (const text of texts) {
    const run = groupRunOf(text, asked);
    actions.push(...run.actions);
    refused.push(...run.refused);
    out.push(run.text);
  }
  const done: GroupAction[] = [];
  let failed = false;
  let cannot = false;
  for (const action of actions) {
    if (line.runGroup === undefined) {
      cannot = true;
      continue;
    }
    try {
      await line.runGroup(place, action);
      done.push(action);
      console.log(JSON.stringify({ event: "group_run", kind: action.kind, outcome: "done" }));
    } catch (error) {
      failed = true;
      console.log(JSON.stringify({ event: "group_run", kind: action.kind, outcome: "failed", error: error instanceof Error ? error.name : "error" }));
    }
  }
  for (const why of refused) console.log(JSON.stringify({ event: "group_run", outcome: "refused", why }));
  const told = cannot
    ? GROUP_RUN_LINES.cannot
    : failed
      ? GROUP_RUN_LINES.failed
      : refused.includes("add_not_in_their_words") || refused.includes("add_not_an_address")
        ? GROUP_RUN_LINES.addNotTheirs
        : refused.includes("photo_none")
          ? GROUP_RUN_LINES.photoNone
          : null;
  const why = cannot ? "cannot" : failed ? "failed" : told === GROUP_RUN_LINES.addNotTheirs ? "add_not_theirs" : told === GROUP_RUN_LINES.photoNone ? "photo_none" : null;
  return { texts: out, told, why, done };
}
