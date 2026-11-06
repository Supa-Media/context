/**
 * A group's voice message, heard before the chat decides whether it is for Tex (2026-11-05 bug hunt: "Tex, find us a
 * dinner spot" said as a voice message in a group got no answer, the same words typed did).
 *
 * The texting Worker decides from a group message's words whether it is addressed to Tex (`apps/agent/src/groupInbox.ts`
 * `acceptGroup`), and a voice message has none: its words were only made here, inside the turn, after that decision.
 * So the Worker asks this route first, over the `TexTexts` service binding (no public URL, no secret of its own), and
 * gates on what was said. The transcription is the one a turn uses (`hearVoiceMessages`, the meetings service with its
 * silence filtering and its rate limit by caller), so nothing new hears the audio.
 *
 * The audio and the words are answered, never kept or logged here; the caller id is the chat's hash, never a number.
 */

import { hearVoiceMessages, MAX_AUDIO_BYTES } from "./attachments.js";
import { transcriptionForwarder } from "../ingestion/transcription.js";

/** The path the Worker posts to on the `TexTexts` binding. */
export const TEXTS_HEAR_PATH = "/texts/hear";
/** The words handed back, at most: enough to tell who a voice message is for. */
export const MAX_HEARD_CHARS = 2000;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CALLER = /^[a-f0-9]{64}$/;
const AUDIO_TYPE = /^audio\/[a-z0-9.+-]{1,40}$/;
/** Base64 of the largest voice message a turn takes, and a little for the JSON around it. */
const MAX_BODY_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 1024;

async function readHear(request) {
  if (request.method !== "POST") return null;
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object") return null;
    const { audioBase64, mimeType, caller } = body;
    if (typeof audioBase64 !== "string" || audioBase64 === "" || !BASE64.test(audioBase64)) return null;
    if (typeof mimeType !== "string" || !AUDIO_TYPE.test(mimeType)) return null;
    if (typeof caller !== "string" || !CALLER.test(caller)) return null;
    return { audioBase64, mimeType, caller };
  } catch {
    return null;
  }
}

/** `{ text }` with what was said, or `{ text: null }` when nothing could be heard (no service, two failures, silence). */
export async function hearForTexts(request, env, { transcribe = transcriptionForwarder(env) } = {}) {
  const ask = await readHear(request);
  if (ask === null) return new Response(null, { status: 400 });
  const [heard] = await hearVoiceMessages([{ name: "voice message", mediaType: ask.mimeType, data: ask.audioBase64 }], transcribe, ask.caller);
  const words = heard?.heard === true && typeof heard.text === "string" ? heard.text.trim().slice(0, MAX_HEARD_CHARS) : "";
  return Response.json({ text: words === "" ? null : words });
}
