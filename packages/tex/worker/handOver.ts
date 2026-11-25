/**
 * Every incoming text's head runs in the gateway (step 3 of Tex's config graph, docs/architecture/tex.md): the webhook
 * hands it to the gateway's `TexTexts` entrypoint at `/texts/arrive`, which queues it in the gateway's TexChat, the only
 * place a chat lives (part C of the runtime simplification: the Worker's SenderInbox class is deleted, 2026-11-25).
 *
 * A hand-over that fails (a non-200, a throw, an outcome it does not know) answers the webhook 503, so the provider
 * sends the text again (Photon's pump retries every 5xx, `infra/photon-bridge/src/pump.ts`), and the chat drops the
 * repeat by its event id. The log names the kind and the outcome, never the text, the phone or the inbox name.
 */

import type { TextsBinding } from "./gatewaySession";

/** The hand-over's kinds: a 1:1 text, a group message, a tapback, a group whose members changed, an edit of a text, and Tex added to a group. */
export type HandOverKind = "one" | "group" | "react" | "members" | "edit" | "joined";

/** Every outcome the chat object's routes answer with (`inbox.ts` accept and react, `groupInbox.ts` acceptGroup, an edit's "same"). */
const OUTCOMES = ["queued", "duplicate", "full", "preview", "kept", "ignored", "noted", "held", "dropped", "redirected", "same", "off", "already"] as const;
export type HandOverOutcome = (typeof OUTCOMES)[number] | "failed";

/**
 * POSTs one text (or tapback, or members change) to the gateway's `/texts/arrive`. Resolves to the gateway's outcome,
 * or "failed" for anything that is not a 200 with a known outcome, a throw included.
 */
export async function handOver(
  binding: TextsBinding,
  call: { kind: HandOverKind; inbox: string; eventId?: string; message: unknown; origin?: string },
): Promise<HandOverOutcome> {
  const outcome = await arrive(binding, call);
  console.log(JSON.stringify({ event: "intake_handover", kind: call.kind, outcome }));
  return outcome;
}

async function arrive(
  binding: TextsBinding,
  call: { kind: HandOverKind; inbox: string; eventId?: string; message: unknown; origin?: string },
): Promise<HandOverOutcome> {
  try {
    const response = await binding.fetch("https://gateway/texts/arrive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call),
    });
    if (response.status !== 200) return "failed";
    const body: unknown = await response.json();
    const outcome = typeof body === "object" && body !== null ? (body as { outcome?: unknown }).outcome : undefined;
    return OUTCOMES.find((known) => known === outcome) ?? "failed";
  } catch {
    return "failed";
  }
}

/** The event id a message carries, if it has one (every 1:1 and group message does; members changes do not). */
function eventIdOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const id = (message as { eventId?: unknown }).eventId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * The Worker's one call site per forward: the Response to answer the webhook with. 200 for every outcome the chat
 * gave (as its routes answer: the webhook is not asked to send it again); 503 when the hand-over failed, so the
 * webhook sends it again; 501 when this Worker has no gateway bound to hand it to.
 */
export async function toChat(
  env: { GATEWAY_TEXTS?: TextsBinding },
  kind: HandOverKind,
  inbox: string,
  message: unknown,
  origin?: string,
): Promise<Response> {
  if (env.GATEWAY_TEXTS === undefined) return new Response(null, { status: 501 });
  const outcome = await handOver(env.GATEWAY_TEXTS, { kind, inbox, eventId: eventIdOf(message), message, origin });
  return new Response(null, { status: outcome === "failed" ? 503 : 200 });
}
