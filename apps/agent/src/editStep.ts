/**
 * A person's edit or unsend of a text they sent (node `edit`, `texConfig.json`, "A text is edited or unsent"; Dev2,
 * 2026-11-16: "Build edit support in Tex", "not just edits but deleted messages as well"). Photon's line hears
 * iMessage's Edit and Undo Send (`photonInbound.ts`); Sendblue sends neither.
 *
 * The chat object finds what it changed (`replyQuote.ts` `editedOf`: the earlier text's event, by the handle it came
 * with, else the line's own copy of its words) and asks the gateway's graph (`/texts/edit` on `TexTexts`), which says:
 * - "same": an edit that changed nothing; nothing is kept.
 * - "record": a typo's worth; the edit is kept in the chat's record, marked as the edit of that text, and takes no turn.
 * - "turn": the edit is kept the same way and queued like a text, so Triage, Decide and Tex take it as they take any.
 * - "withdraw": an unsend; it is kept, marked as that text taken back, and the text is taken out of the queue if it is
 *   still waiting there (a turn already running keeps it). It takes no turn.
 * A failure of the step is a "turn" for an edit and a "withdraw" for an unsend: neither is dropped because this step
 * could not answer.
 *
 * The step's own record (`stepEvents.ts`) carries counts and the outcome, never words: the edit's words are in the
 * chat's record as its event, and the earlier text's in its own.
 */

import type { TextsBinding } from "./gatewaySession";
import type { InboxStorage } from "./inbox";
import type { Edited } from "./inbound";
import type { PhotonEdit } from "./photonInbound";
import type { Message } from "./reply";
import type { GroupMessage } from "./sendblueGroups";
import { editedOf } from "./replyQuote";
import { logStep } from "./stepEvents";

export type EditTo = "turn" | "record" | "same" | "withdraw";
export type EditStepDeps = { texts?: TextsBinding; now: () => number };

/** What the step found and the node said, for the chat object to act on. */
export type EditOutcome = { to: EditTo; edited: Edited };

/** The chat an edit is in: its group's id, or its 1:1 chat's. */
export const editChat = (edit: PhotonEdit): string => edit.groupId ?? edit.chatId ?? "";

/** The step: what the edit or unsend changed, and what the node says it is. Logged on every path. */
export async function editStep(storage: InboxStorage, edit: PhotonEdit, deps: EditStepDeps): Promise<EditOutcome> {
  const started = deps.now();
  const kind = edit.groupId !== undefined ? "group" : "one";
  const change = edit.kind === "unsent" ? "unsend" : "edit";
  const chat = editChat(edit);
  const found = await editedOf(storage, chat, edit.messageId, edit.previous);
  const edited: Edited = change === "unsend" ? { ...found, unsent: true } : found;
  const fallback: EditTo = change === "unsend" ? "withdraw" : "turn";
  const seen = {
    kind,
    change,
    chars: edit.text?.length ?? 0,
    // Where the words before came from: the chat's own event, the line's copy, or nowhere.
    earlier: edited.of !== undefined && edited.words !== undefined ? "event" : edited.words !== undefined ? "line" : "none",
    ...(edited.words !== undefined ? { earlierChars: edited.words.length } : {}),
  };
  const done = async (to: EditTo, why: string | undefined, cause?: string): Promise<EditOutcome> => {
    console.log(JSON.stringify({ event: "text_edit", kind, change, outcome: to, ...(cause ? { reason: cause } : {}) }));
    await logStep(storage, chat, { name: "edit", of: `${change}-${kind}`, ok: cause === undefined, ms: deps.now() - started, input: seen, output: { to, ...(why ? { why } : {}) }, ...(cause ? { cause } : {}) }, deps.now());
    return { to, edited };
  };
  if (deps.texts === undefined) return await done(fallback, undefined, "no_gateway");
  let output: { to?: unknown; why?: unknown };
  try {
    const input = { kind, change, ...(edit.text !== undefined ? { words: edit.text } : {}), ...(edited.words !== undefined ? { earlier: edited.words } : {}) };
    const response = await deps.texts.fetch("https://gateway/texts/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) return await done(fallback, undefined, `gateway_${response.status}`);
    output = (await response.json()) as typeof output;
  } catch {
    return await done(fallback, undefined, "gateway_unreachable");
  }
  const why = typeof output.why === "string" ? output.why.slice(0, 200) : undefined;
  // An unsend is only ever taken back, and an edit never is: an answer the other way is the node's mistake.
  const fits = change === "unsend" ? output.to === "withdraw" : output.to === "same" || output.to === "record" || output.to === "turn";
  if (fits) return await done(output.to as EditTo, why);
  return await done(fallback, why, "unknown_answer");
}

/** A 1:1 edit as the text the queue takes: its new words (none for an unsend), on the message it edits, marked `edited`. */
export function editedText(edit: PhotonEdit, edited: Edited): Message {
  return { kind: "message", eventId: edit.eventId, chatId: edit.chatId ?? "", from: edit.from, messageId: edit.messageId, text: edit.text ?? "", edited };
}

/** A group's edit as the message the group queue takes, the same way. */
export function editedGroupMessage(edit: PhotonEdit, edited: Edited): GroupMessage {
  return {
    kind: "group-message",
    eventId: edit.eventId,
    groupId: edit.groupId ?? "",
    line: edit.line,
    from: edit.from,
    participants: edit.participants ?? [edit.from],
    messageId: edit.messageId,
    text: edit.text ?? "",
    edited,
  };
}
