/**
 * Warming the model's cache before the person's next text (Dev2, 2026-11-20, the cache rules: "the cache is warmed when
 * the chat opens or the person starts typing"). Node `warm` (`graph/nodes/warm.js`), on the shelf until a Lab draft
 * wires it: with it in the config, each texted front-door turn keeps the request its first round sent, cut at the
 * history's end (`keptPrefix`), in the chat's own home (`texStore/warm.js`). When the person reads Tex's text, opens the
 * chat or starts typing, the texting Worker or the app asks `/texts/warm`, and the node sends that prefix again with a
 * one-token answer (`warmRequest`), so the cache is written before their text arrives and its first round reads it.
 *
 * Only the prefix is sent: the same tools, system and history bytes the next turn starts with, so the next turn's
 * history mark finds it within Anthropic's 20-block lookback.
 */
import { dayOf } from "./jobLog.js";
import { ledgerPlace } from "./ledger.js";

export const WARM_NODE = "warm";
/** What the warming request asks after the prefix: an answer of one token, never read. */
export const WARM_ASK = "(This only warms the cache. Answer with one word.)";

/** Whether the config runs node `warm`: only then is a prefix kept. */
export function warmWired(config) {
  return Array.isArray(config?.nodes) && config.nodes.some((node) => node?.id === WARM_NODE && node.on !== false);
}

const marked = (message) => Array.isArray(message?.content) && message.content.some((block) => block?.cache_control);

/**
 * The request a turn's round sent, cut after its history's last message (the first of the two marked messages a
 * texted turn's round carries, `aiGateway.js` `gatewayBody`), or null when it has no history to cache.
 */
export function keptPrefix(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (messages === null) return null;
  const ends = messages.flatMap((message, at) => (marked(message) ? [at] : []));
  if (ends.length < 2) return null;
  return { ...body, messages: messages.slice(0, ends[0] + 1) };
}

/** The kept prefix sent again: the same bytes, then the one-line ask, and room for one token. */
export function warmRequest(prefix) {
  return { ...prefix, max_tokens: 1, messages: [...prefix.messages, { role: "user", content: [{ type: "text", text: WARM_ASK }] }] };
}

/**
 * For one texted turn: `(body) => void`, told each round's request once it was answered (`aiGateway.js` `onSent`); the
 * first one with a history is kept as the chat's prefix, never awaited by the reply. Null when the chat keeps no home.
 */
export function prefixKeeper({ store, session, timeZone = null, now = Date.now, log = (line) => console.log(JSON.stringify(line)) }) {
  const place = ledgerPlace(session);
  const home = place === null || typeof store?.texLedger !== "function" ? null : store.texLedger(place.owner.chat ?? null);
  if (home === null || typeof home?.keepWarm !== "function") return null;
  let kept = false;
  return (body) => {
    if (kept) return;
    const prefix = keptPrefix(body);
    if (prefix === null) return;
    kept = true;
    const zone = timeZone || "UTC";
    Promise.resolve(home.keepWarm(place.chat, { day: dayOf(now(), zone), zone, body: prefix }))
      .then(() => log({ event: "warm_prefix_kept", messages: prefix.messages.length }))
      .catch((error) => log({ event: "warm_prefix_kept", outcome: "failed", reason: String(error?.name ?? "error").slice(0, 40) }));
  };
}
