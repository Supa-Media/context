/**
 * Key rotation for connectors (`functions/connections.ts`): the tokens a
 * person's connected app was given, and the client secret an app's
 * authorization server issued Context when it registered.
 *
 * Two more tables, so two more walks, for the reason `rekeyWorkspaceSecrets.ts`
 * gives: the cross-schema guard catches an unaccounted column *name*, never a
 * table the pass does not visit. Neither is exempt. Losing a connection's
 * tokens makes the person connect the app again from a link Tex has to send;
 * losing a registration's secret breaks every refresh made under it.
 *
 * Handlers only, opening nothing; `credentialOpening.ts` decrypts and re-seals.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { envelopeKeyId } from "../crypto";

const connectionField = v.union(v.literal("encryptedAccessToken"), v.literal("encryptedRefreshToken"));

/** An envelope sealed under an older key, or null when it is current or absent; "unreadable" when its key id can't be read. */
function staleEnvelope(envelope: unknown, currentKeyId: string): string | null | "unreadable" {
  if (typeof envelope !== "string" || envelope.length === 0) return null;
  try {
    return envelopeKeyId(envelope) === currentKeyId ? null : envelope;
  } catch {
    return "unreadable";
  }
}

export const listConnectorRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listConnectorRekeyCandidatesReturns = v.object({
  connections: v.array(
    v.object({ rowId: v.id("providerConnections"), workspaceId: v.id("workspaces"), field: connectionField, envelope: v.string() }),
  ),
  clients: v.array(v.object({ rowId: v.id("providerOAuthClients"), envelope: v.string() })),
  unreadable: v.number(),
});

export interface ConnectorRekeyCandidates {
  connections: {
    rowId: Id<"providerConnections">;
    workspaceId: Id<"workspaces">;
    field: "encryptedAccessToken" | "encryptedRefreshToken";
    envelope: string;
  }[];
  clients: { rowId: Id<"providerOAuthClients">; envelope: string }[];
  unreadable: number;
}

export async function listConnectorRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listConnectorRekeyCandidatesArgs>,
): Promise<ConnectorRekeyCandidates> {
  const out: ConnectorRekeyCandidates = { connections: [], clients: [], unreadable: 0 };
  for (const row of await ctx.db.query("providerConnections").take(args.limit)) {
    for (const field of ["encryptedAccessToken", "encryptedRefreshToken"] as const) {
      const stale = staleEnvelope(row[field], args.currentKeyId);
      if (stale === "unreadable") out.unreadable += 1;
      else if (stale !== null) out.connections.push({ rowId: row._id, workspaceId: row.workspaceId, field, envelope: stale });
    }
  }
  for (const row of await ctx.db.query("providerOAuthClients").take(args.limit)) {
    const stale = staleEnvelope(row.encryptedClientSecret, args.currentKeyId);
    if (stale === "unreadable") out.unreadable += 1;
    else if (stale !== null) out.clients.push({ rowId: row._id, envelope: stale });
  }
  return out;
}

export const applyConnectionRekeyArgs = {
  rowId: v.id("providerConnections"),
  field: connectionField,
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

/** Conditional on the exact bytes read, so a refresh or reconnect mid-pass is never overwritten. */
export async function applyConnectionRekeyHandler(ctx: MutationCtx, args: ObjectType<typeof applyConnectionRekeyArgs>) {
  const row = await ctx.db.get(args.rowId);
  if (row === null || row[args.field] !== args.expectedEnvelope) return false;
  await ctx.db.patch(args.rowId, { [args.field]: args.envelope });
  await recordAudit(ctx, { workspaceId: row.workspaceId, action: "encryption.rekeyed" });
  return true;
}

export const applyOAuthClientRekeyArgs = {
  rowId: v.id("providerOAuthClients"),
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export async function applyOAuthClientRekeyHandler(ctx: MutationCtx, args: ObjectType<typeof applyOAuthClientRekeyArgs>) {
  const row = await ctx.db.get(args.rowId);
  if (row === null || row.encryptedClientSecret !== args.expectedEnvelope) return false;
  await ctx.db.patch(args.rowId, { encryptedClientSecret: args.envelope });
  return true;
}
