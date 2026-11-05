/**
 * What a text replies to, kept on its own event (Dev2, 2026-11-05: "whenever
 * we respond to something ... it should be recorded as, this was in response
 * to, and then quote the full text it was in response to").
 *
 * A reply typed under an earlier message (an inline reply, or a text inside an
 * iMessage thread) is logged with `replyTo`, the event id of the message it
 * answers, and `quoted`, that message's full words. Threads get interwoven
 * with other messages, so an id alone left the model to work out which text
 * was meant: in Dev2's chat of 2026-11-05 every text typed in a thread reached
 * the model with only "this was typed inside an iMessage thread", and Tex
 * answered things nobody had asked.
 *
 * The message is found in the chat's own events (`chatRead.ts`): by the
 * provider's handle where Tex keeps one (`HANDLES_KEY`, a group's, whose
 * webhook names only the handle), else by its words (a 1:1 reply, whose
 * webhook is resolved to the quoted words before it is queued). One that is
 * not found keeps the provider's quoted words, if any, and no id.
 */

import { chatEvents } from "./chatRead";
import type { TexEvent } from "./events";
import type { InboxStorage } from "./inbox";

/** Provider handles of the chat's recent messages, theirs and Tex's, each with its event id: never words. */
export const HANDLES_KEY = "evhandles";
/** The most handles kept: about a day of a busy group. */
export const MAX_HANDLES = 200;
const HANDLE = /^[A-Za-z0-9_.:@-]{1,128}$/;

type Handle = { h: string; ev: string };

/** Keep a message's provider handle beside its event id, so a later reply naming the handle finds the event. Never throws. */
export async function noteHandle(storage: InboxStorage, handle: string | undefined, ev: string | undefined): Promise<void> {
  try {
    if (typeof handle !== "string" || !HANDLE.test(handle) || typeof ev !== "string") return;
    const kept = (await storage.get<Handle[]>(HANDLES_KEY)) ?? [];
    await storage.put(HANDLES_KEY, [...kept.filter((entry) => entry.h !== handle), { h: handle, ev }].slice(-MAX_HANDLES));
  } catch {
    // Best effort: a reply to it is then found by its words, or kept without an id.
  }
}

const folded = (text: string) => text.replace(/\s+/g, " ").replace(/[…]+$|\.{3}$/, "").trim().toLowerCase();

/** Whether quoted words are this text's: the same, or one cut short of the other (a long text is quoted with its beginning). */
export function sameText(text: string, quoted: string): boolean {
  const [x, y] = [folded(text), folded(quoted)];
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * The fields a reply's event carries: `replyTo` and the replied-to message's full `quoted` words, or only the
 * provider's `quoted` words when the message is not among the chat's events, or nothing when it is not a reply.
 */
export async function replyFields(storage: InboxStorage, chat: string, { handle, words }: { handle?: string; words?: string }): Promise<Pick<TexEvent, "replyTo" | "quoted">> {
  const quoted = typeof words === "string" ? words.trim() : "";
  const byHandle = typeof handle === "string" ? ((await storage.get<Handle[]>(HANDLES_KEY)) ?? []).find((entry) => entry.h === handle)?.ev : undefined;
  if (byHandle === undefined && quoted === "") return {};
  let events: TexEvent[] = [];
  try {
    events = await chatEvents(storage, chat);
  } catch {
    events = [];
  }
  const found =
    (byHandle !== undefined ? events.find((event) => event.id === byHandle) : undefined) ??
    (quoted !== "" ? [...events].reverse().find((event) => typeof event.text === "string" && event.kind !== "reaction" && sameText(event.text, quoted)) : undefined);
  if (found !== undefined && typeof found.text === "string" && found.text !== "") return { replyTo: found.id, quoted: found.text };
  return { ...(byHandle !== undefined ? { replyTo: byHandle } : {}), ...(quoted !== "" ? { quoted } : {}) };
}
