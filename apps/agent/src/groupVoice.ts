/**
 * A group's voice message, heard before the chat decides whether it is for Tex (2026-11-05 bug hunt: "Tex, find us a
 * dinner spot for Friday" said as a voice message got no answer; the same words typed did).
 *
 * Whether a group message is for Tex is decided from its words (`groupInbox.ts` `acceptGroup`), and a voice message
 * arrives with none: its words were only made inside the gateway's turn, after that decision. So a message that is only
 * a voice recording is downloaded here and heard by the gateway's `TexTexts` entrypoint (`apps/mcp/src/agent/textsHear.js`,
 * the transcription a turn uses), and the chat gates on what was said (`heard`). The turn itself still gets the
 * recording and hears it as before; `heard` only decides whether a turn runs.
 *
 * Best effort and bounded: no binding, a download or transcription that fails, or one slower than `HEAR_TIMEOUT_MS`,
 * leaves the message as it came, so the chat is never worse off than before. `heard` is set only here, from the
 * recording: the Durable Object drops any `heard` a request names before calling this (`index.ts` `/group-accept`).
 */

import { prepareAttachments } from "./attachments";
import type { Fetch } from "./clients";
import type { TextsBinding } from "./gatewaySession";
import { sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";

/** The path of the gateway's hearing route on the `TexTexts` binding (`textsHear.js` `TEXTS_HEAR_PATH`). */
export const HEAR_URL = "https://gateway/texts/hear";
/** Download and transcription together, at most: the webhook waits on this. */
export const HEAR_TIMEOUT_MS = 12_000;
/** The words kept to gate on, at most. */
export const MAX_HEARD = 2000;

/** File endings a phone gives a voice recording (`attachments.ts` `AUDIO_EXTENSIONS`). */
const AUDIO_FILE = /\.(?:caf|m4a|aac|mp3|amr|wav|ogg|opus|webm)$/i;

export type HearDeps = { fetch: Fetch; gateway?: TextsBinding; log?: (fields: Record<string, unknown>) => void };

/** Whether a group message is only a voice recording: no words, one audio file. */
export function onlyVoice(message: GroupMessage): boolean {
  if (message.sms || message.reaction !== undefined || message.text.trim() !== "") return false;
  const files = message.attachments ?? [];
  return files.length === 1 && (files[0].mimeType.startsWith("audio/") || AUDIO_FILE.test(files[0].filename));
}

/** The message with `heard` set to what its voice recording says, or as it came. Never throws. */
export async function heardInGroup(message: GroupMessage, deps: HearDeps): Promise<GroupMessage> {
  if (deps.gateway === undefined || !onlyVoice(message)) return message;
  const log = deps.log ?? ((fields) => console.log(JSON.stringify(fields)));
  const started = Date.now();
  try {
    const words = await withTimeout(hear(message, deps.fetch, deps.gateway), HEAR_TIMEOUT_MS);
    log({ event: "group_voice_heard", outcome: words === null ? "nothing" : "heard", ms: Date.now() - started });
    return words === null ? message : { ...message, heard: words };
  } catch {
    log({ event: "group_voice_heard", outcome: "failed", ms: Date.now() - started });
    return message;
  }
}

async function hear(message: GroupMessage, fetcher: Fetch, gateway: TextsBinding): Promise<string | null> {
  const [audio] = await prepareAttachments(message.attachments ?? [], { fetch: fetcher });
  if (audio === undefined || !("data" in audio) || !audio.mediaType.startsWith("audio/")) return null;
  const response = await gateway.fetch(HEAR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The chat's hash, never a number: the transcription service limits by it.
    body: JSON.stringify({ audioBase64: audio.data, mimeType: audio.mediaType, caller: await sha256Hex(`${message.line}:${message.groupId}`) }),
  });
  if (!response.ok) return null;
  const { text } = (await response.json()) as { text?: unknown };
  return typeof text === "string" && text.trim() !== "" ? text.trim().slice(0, MAX_HEARD) : null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new Error("timeout")), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
