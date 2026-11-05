/**
 * One sender: how one part of an answer reaches a chat, 1:1 and group alike
 * (the one-door plan, `docs/architecture/tex.md`). A word meant for us is
 * dropped; a text is sent, remembered so a reply to it reaches Tex, and
 * logged; a picture that never uploaded, or that the line refuses, is logged
 * as never delivered and said once, as a line of the system's, so Tex's
 * history shows what the person was told. Each lane brings its own way out
 * (`PartLine`): the 1:1 lane its idempotency keys and threads (`inbox.ts`),
 * the group its retry guard and group line (`groupSay.ts`). Cards and
 * carousels stay the 1:1 lane's until they are proven in groups.
 */

import { kindOf, type TexEvent } from "./events";
import { isControlWord } from "./controlWords";
import { PICTURE_FAILED } from "./outgoing";

export type PartLogged = Omit<TexEvent, "id" | "at" | "chat" | "from">;

export type PartLine<P> = {
  /** Send one text; `failure` is the line saying a picture did not go. The handle a reply to it carries, if any. */
  sendText(text: string, failure: boolean): Promise<string | undefined>;
  /** Send one picture: the address it went by (undefined: sent by its bytes), or null when it never uploaded. */
  sendPicture(picture: P): Promise<string | undefined | null>;
  /** Whether a picture's failure is the line refusing it (said once, never retried) rather than one to retry. */
  refused(error: unknown): boolean;
  /** Keep a text's handle, so an inline reply to it reaches Tex; `ev` is the event it was logged as, when the lane says. */
  remember(handle: string | undefined, text: string, ev?: string): Promise<void>;
  /** Log what went, or did not: the failure line is the system's, never a turn's. The event's id, when the lane keeps one. */
  log(part: PartLogged, system: boolean): Promise<string | void>;
};

/** Send one text. False when it was only a control word, so nothing went. */
export async function sendWords<P>(line: PartLine<P>, text: string): Promise<boolean> {
  if (isControlWord(text)) {
    console.log(JSON.stringify({ event: "reply", outcome: "control_word_dropped" })); // a word meant for us, never a text (`controlWords.ts`)
    return false;
  }
  // A picture that never uploaded (`partsFor`) stands in the answer as the line saying so.
  if (text === PICTURE_FAILED) return (await saidFailed(line, "upload_failed"), true);
  const handle = await line.sendText(text, false);
  const ev = await line.log({ kind: kindOf(text), text, delivered: true }, false);
  await line.remember(handle, text, ev ?? undefined);
  return true;
}

/** Send one picture. False when it did not go and the chat was told so; a failure that is not a refusal throws, to be retried. */
export async function sendPicturePart<P>(line: PartLine<P>, picture: P): Promise<boolean> {
  let url: string | undefined | null;
  try {
    url = await line.sendPicture(picture);
  } catch (error) {
    if (!line.refused(error)) throw error;
    return await saidFailed(line, "send_refused");
  }
  if (url === null) return await saidFailed(line, "upload_failed");
  await line.log({ kind: "picture", delivered: true, ...(url ? { text: url } : {}) }, false);
  return true;
}

async function saidFailed<P>(line: PartLine<P>, reason: "upload_failed" | "send_refused"): Promise<false> {
  // Logged once the line went: a send that fails retries the reply from this part, and nothing is logged twice.
  const handle = await line.sendText(PICTURE_FAILED, true);
  await line.log({ kind: "picture", delivered: false, reason }, false);
  const ev = await line.log({ kind: "text", text: PICTURE_FAILED, delivered: true }, true);
  await line.remember(handle, PICTURE_FAILED, ev ?? undefined);
  return false;
}
