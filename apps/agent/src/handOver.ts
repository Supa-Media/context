/**
 * Where an incoming text's head runs (`INTAKE`, step 3 of Tex's config graph, docs/architecture/tex.md).
 *
 * "worker" keeps today's path: the webhook hands the text to its SenderInbox Durable Object. "gateway" hands it to
 * the gateway's `TexTexts` entrypoint at `/texts/arrive`, which queues it in the gateway's TexChat. The default is
 * "worker", so nothing changes until the var is flipped.
 *
 * A hand-over that fails (a non-200, a throw, an outcome it does not know) falls back to the SenderInbox, so a text
 * is never dropped by the move. The log names the kind and the outcome, never the text, the phone or the inbox name.
 */

import type { TextsBinding } from "./gatewaySession";

export type Intake = "worker" | "gateway";

/** The hand-over's kinds: a 1:1 text, a group message, a tapback, and a group whose members changed. */
export type HandOverKind = "one" | "group" | "react" | "members";

/** Every outcome the chat object's routes answer with (`inbox.ts` accept and react, `groupInbox.ts` acceptGroup). */
const OUTCOMES = ["queued", "duplicate", "full", "preview", "kept", "ignored", "noted", "held", "dropped"] as const;
export type HandOverOutcome = (typeof OUTCOMES)[number] | "failed";

/** "gateway" only for exactly that string (trimmed); anything else, unset included, is "worker". */
export function intakeOf(value: string | undefined): Intake {
  return typeof value === "string" && value.trim() === "gateway" ? "gateway" : "worker";
}

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
 * The Worker's one call site per forward. Returns the Response to answer the webhook with when the gateway took the
 * text (200 for every outcome, as the SenderInbox's own routes answer: the webhook is not asked to send it again), or null
 * when the SenderInbox should take it: the var says "worker", the binding is absent, or the hand-over failed.
 */
export async function toChat(
  env: { INTAKE?: string; GATEWAY_TEXTS?: TextsBinding },
  kind: HandOverKind,
  inbox: string,
  message: unknown,
  origin?: string,
): Promise<Response | null> {
  if (intakeOf(env.INTAKE) !== "gateway" || env.GATEWAY_TEXTS === undefined) return null;
  const outcome = await handOver(env.GATEWAY_TEXTS, { kind, inbox, eventId: eventIdOf(message), message, origin });
  if (outcome === "failed") {
    console.log(JSON.stringify({ event: "intake_handover_fallback", kind }));
    return null;
  }
  return new Response(null, { status: 200 });
}
