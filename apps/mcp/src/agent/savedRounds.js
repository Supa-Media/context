/**
 * A TURN CARRIES ON WHERE ITS LAST TRY STOPPED (Dev2, 2026-11-17: "yeah lets take that idea immediately", LangGraph's
 * save-after-every-step, built on our own pieces).
 *
 * A texted turn that dies after its tools ran (a crash in its checks, the gateway out of memory, a dropped stream) is
 * tried again by the texting Worker, and until now that try started from the person's text: the same mail search, the
 * same page opened, the same note written again, minutes later. Now, after each round of tool calls, the turn hands
 * the Worker what it has so far (the model's own calls and what each returned, the rounds after the question), and the
 * next try of the same text hands it back: the model goes on from there, nothing it already did is done again
 * (`turn.js` `resumeFrom`, `onRound`).
 *
 * - Sealed like the warm copy (`warmCopy.js`): AES-GCM under a key derived from `GATEWAY_SECRET`, which the Worker
 *   never holds, so it keeps bytes it can neither read nor change. A copy it could change would let whoever forged it
 *   put words in a tool's mouth.
 * - Bound to the person, the client and the text: the associated data names the workspace, the actor, the client and
 *   a hash of the question, so a copy never opens on someone else's turn or on another text's (a newer text merged in
 *   starts over, as it should: it asks something else).
 * - Fresh for `ROUNDS_FRESH_MS`: the Worker's tries of one text are minutes apart; an older copy is the world as it was.
 * - A cache, never a copy of record: one that is lost, too big or won't open costs the try its head start, nothing
 *   else. Pictures a tool returned are left out (one line says so); a copy still too large is not made.
 */

import { decodeBase64, encodeBase64 } from "../crypto/bytes.js";

const LABEL = "context-tex-rounds-v1";
const PREFIX = "tr1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How long a try's rounds are carried on: a text's tries are minutes apart (`apps/agent/src/inbox.ts`). */
export const ROUNDS_FRESH_MS = 30 * 60 * 1000;
/** The largest sealed copy made: one Durable Object value, with room to spare. */
export const ROUNDS_MAX_CHARS = 400_000;
/** One tool result's words, kept whole up to this: the model read it all, but a try after reads enough of it. */
export const ROUNDS_RESULT_CHARS = 12_000;
/** What the model reads where a tool showed it a picture the copy did not keep. */
export const PICTURE_LEFT_OUT = "[A picture this call returned was shown to you in an earlier try and is not shown again.]";

const secretOf = (env) => (typeof env?.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length >= 16 ? env.GATEWAY_SECRET : null);

async function roundsKey(secret, usage) {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const info = encoder.encode(LABEL);
  const block = new Uint8Array(info.length + 1);
  block.set(info);
  block[info.length] = 1;
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, block));
  return crypto.subtle.importKey("raw", derived, "AES-GCM", false, [usage]);
}

async function aad(session, question) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(question ?? ""))));
  return encoder.encode(`${LABEL}:${session?.workspaceId}:${session?.actorUserId}:${session?.actorClientId}:${encodeBase64(hash)}`);
}

async function squeeze(bytes, Stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new Stream("gzip"))).arrayBuffer());
}

/** One message as the copy keeps it: pictures out, a long result cut. */
function kept(message, withThinking) {
  if (message?.role === "tool") {
    const text = String(message.text ?? "");
    const pictures = Array.isArray(message.images) && message.images.length > 0;
    const cut = text.length > ROUNDS_RESULT_CHARS ? `${text.slice(0, ROUNDS_RESULT_CHARS)}\n[cut: the rest was read in an earlier try]` : text;
    return { role: "tool", id: message.id, name: message.name, text: pictures ? `${cut}\n${PICTURE_LEFT_OUT}` : cut, ...(message.isError ? { isError: true } : {}) };
  }
  if (message?.role === "assistant") {
    return {
      role: "assistant",
      text: String(message.text ?? ""),
      ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? { toolCalls: message.toolCalls.map(({ id, name, args }) => ({ id, name, args })) } : {}),
      ...(withThinking && Array.isArray(message.content) ? { content: message.content } : {}),
    };
  }
  return { role: "user", text: String(message?.text ?? "") };
}

/**
 * What a turn has done after its question: `messages` the rounds since (assistant calls, tool results, notices), `round`
 * the next round's number. The model's thinking is kept when it fits, so the same model goes on with it; a copy too
 * large with it is made without.
 */
export function roundsSnapshot(messages, round, now = Date.now()) {
  return [true, false].map((withThinking) => ({ v: 1, at: now, round, messages: messages.map((message) => kept(message, withThinking)) }));
}

/** Seal what a turn has done for this person and this text. Null when it can't be made (no key, too large). */
export async function sealRounds(env, session, question, messages, round, now = Date.now()) {
  const secret = secretOf(env);
  if (secret === null || !Array.isArray(messages) || messages.length === 0) return null;
  try {
    const key = await roundsKey(secret, "encrypt");
    const additionalData = await aad(session, question);
    for (const copy of roundsSnapshot(messages, round, now)) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = await squeeze(encoder.encode(JSON.stringify(copy)), CompressionStream);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plain));
      const joined = new Uint8Array(iv.length + sealed.length);
      joined.set(iv);
      joined.set(sealed, iv.length);
      const text = `${PREFIX}${encodeBase64(joined)}`;
      if (text.length <= ROUNDS_MAX_CHARS) return text;
    }
    return null;
  } catch {
    return null;
  }
}

const MESSAGE_ROLES = new Set(["user", "assistant", "tool"]);

/**
 * What an earlier try of this text did, as `{ round, messages }`, or null: none, another person's or text's, tampered,
 * unreadable, stale, or not the shape a turn writes.
 */
export async function openRounds(env, session, question, sealed, now = Date.now()) {
  const secret = secretOf(env);
  if (secret === null || typeof sealed !== "string" || !sealed.startsWith(PREFIX) || sealed.length > ROUNDS_MAX_CHARS) return null;
  try {
    const joined = decodeBase64(sealed.slice(PREFIX.length));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: joined.subarray(0, 12), additionalData: await aad(session, question) }, await roundsKey(secret, "decrypt"), joined.subarray(12));
    const copy = JSON.parse(decoder.decode(await squeeze(new Uint8Array(plain), DecompressionStream)));
    if (copy === null || typeof copy !== "object" || copy.v !== 1) return null;
    if (!Number.isFinite(copy.at) || now - copy.at > ROUNDS_FRESH_MS || copy.at - now > 60_000) return null;
    if (!Number.isSafeInteger(copy.round) || copy.round < 1 || !Array.isArray(copy.messages) || copy.messages.length === 0) return null;
    if (!copy.messages.every((message) => message !== null && typeof message === "object" && MESSAGE_ROLES.has(message.role))) return null;
    return { round: copy.round, messages: copy.messages };
  } catch {
    return null;
  }
}

/** The calls an earlier try made, each with whether it went, for the turn's own record of what it did (`sendBack.js`). */
export function callsIn(messages) {
  const results = new Map(messages.filter((message) => message.role === "tool").map((message) => [message.id, message]));
  return messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.toolCalls))
    .flatMap((message) => message.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args, ok: results.get(call.id)?.isError !== true })));
}
