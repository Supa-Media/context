/**
 * The email worker's three `/gateway/ingest/*` handlers (`http.ts` declares
 * their routes behind `emailWorkerRoute`, which checks the worker's secret).
 *
 * Moved out of `http.ts` unchanged to keep that file under its line budget.
 * Their doc comments stay with their routes in `http.ts`.
 */
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { ingestEncryptionSiblings } from "../managedEncryptionFns/storeOption";
import { servedNoteCount } from "../nodes/servedCount";
import { randomOpaqueToken, json, stringField } from "../gatewayAuth";
import { logIngest } from "../ingestLog";

export async function ingestResolveHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  // `username` is the worker's word for the local part of the address a sender
  // wrote. It is a name in the one global namespace usernames and context slugs
  // share, and it resolves only if it belongs to a personal context — see
  // `resolvePersonalContextForIngestion`.
  const username = stringField(body, "username");
  const sizeBytes = body.sizeBytes;
  // A malformed request is answered exactly like an unknown name. A 400 would
  // tell a caller holding the worker secret which part of its request was the
  // bad one, and there is nothing here a legitimate caller could act on.
  //
  // It is, however, recorded — because "the caller sent the wrong field name"
  // and "that name does not resolve" being one answer is exactly what makes
  // this route impossible to debug from outside. An operator probing with
  // `{"name": …}` instead of `{"username": …}` gets a perfectly ordinary
  // `{"ingestion":null}` that never touches the database, and reads it as
  // evidence about their data. That happened. The reason is operator-only; the
  // response is unchanged. See `functions/lib/ingestLog.ts`.
  if (
    username === null ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes)
  ) {
    logIngest({
      event: "resolve_refused",
      reason: username === null ? "missing_username" : "missing_size_bytes",
    });
    return json({ ingestion: null });
  }

  // `envelopeFrom` is sent and deliberately not read. The contract offers it
  // "for rate limiting only; NOT authority", and it is attacker-chosen, so
  // limiting on it protects nothing — the limit below is keyed on the
  // recipient, which is the thing being probed. Reading it here would also put
  // a stranger's address one refactor away from a log line.
  //
  // Minted before the lookup, so the work done is the same whether or not the
  // name resolves. Nothing is written unless the mutation decides to write it.
  const ticket = randomOpaqueToken(32);
  const resolution = await ctx.runMutation(
    internal.functions.ingestionGateway.resolveForIngestion,
    { name: username, hashedTicket: await hashToken(ticket), sizeBytes },
  );
  if (resolution === null) return json({ ingestion: null });

  return json({ ingestion: { ticket, ...resolution } });
}

export async function ingestBindingHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const ticket = stringField(body, "ticket");
  if (ticket === null) return json({ binding: null });

  const binding = await ctx.runAction(
    internal.functions.ingestionGateway.openIngestionBinding,
    { hashedTicket: await hashToken(ticket) },
  );
  if (binding === null) return json({ binding });
  // The free managed tier's note cap, a sibling as on `/gateway/binding`, for
  // the workspace read off the ticket's own row — never anything the caller
  // sent. Absent for every other context, and absent on a failed read: a
  // billing lookup must not cost somebody their mail.
  const noteCap = await ctx
    .runQuery(internal.functions.billing.noteCap, {
      workspaceId: binding.workspaceId,
    })
    .catch(() => null);
  // What the cap counts, from the Convex tree's rows and never the bucket
  // (`lib/nodes/servedCount.ts`); asked only when there is a cap. Absent when
  // the tree cannot say, and the worker then admits the note.
  const counted = noteCap === null ? null : await servedNoteCount(ctx, binding.workspaceId);
  const managed = await ingestEncryptionSiblings(ctx, binding.workspaceId);
  if (managed === null) return json({ binding: null });
  return json({
    binding,
    ...(noteCap === null ? {} : { noteCap }),
    ...(counted === null ? {} : { noteCount: counted.notes }),
    // Every workspace is keyed (2026-10-22): the email worker writes each note to its id key.
    keyed: true,
    ...managed,
  });
}

export async function ingestRecordHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const ticket = stringField(body, "ticket");
  const outcome = body.outcome === "duplicate" ? "duplicate" : "captured";
  const bytes =
    typeof body.bytes === "number" && Number.isFinite(body.bytes)
      ? body.bytes
      : 0;
  if (ticket === null) return json({ ok: true });

  await ctx.runMutation(internal.functions.ingestionGateway.recordIngestion, {
    hashedTicket: await hashToken(ticket),
    outcome,
    bytes,
  });
  return json({ ok: true });
}
