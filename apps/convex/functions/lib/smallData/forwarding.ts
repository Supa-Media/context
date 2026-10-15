/**
 * The forwarding ledger held in Convex (`forwardingEntries`): read whole, and
 * changed by the gateway's own engine (`apps/mcp/src/forwarding.js`), so the
 * rules that make it safe to consult — a folder move is one entry, chains
 * collapse as they are recorded, the most specific rule wins, and it is
 * capped — are the same code wherever the ledger lives.
 *
 * A workspace holds at most `FORWARDING_ENTRY_CAP` rows, so a change reads
 * them all, runs `addForwarding`, and writes only the rows that changed.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { addForwarding, cleanMoves } from "../../../../mcp/src/forwarding.js";
import { markChanged } from "./state";

export type ForwardingKind = "note" | "folder";
export interface ForwardingEntry {
  from: string;
  to: string;
  kind: ForwardingKind;
  at: number;
}
export interface ForwardingMove {
  from: string;
  to: string;
  kind: ForwardingKind;
}

/** Rows a ledger may hold past the engine's cap, as a bound on one read. */
const LEDGER_READ_BOUND = 4_000;

export async function ledgerRows(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"forwardingEntries">[]> {
  return await db
    .query("forwardingEntries")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
    .take(LEDGER_READ_BOUND);
}

/** The ledger, oldest first, as the engine reads it. */
export function ledgerOf(rows: readonly Doc<"forwardingEntries">[]): { version: 1; entries: ForwardingEntry[] } {
  return { version: 1, entries: rows.map((row) => ({ from: row.from, to: row.to, kind: row.kind, at: row.at })) };
}

const keyOf = (entry: { from: string; kind: string }) => `${entry.kind}\u0000${entry.from}`;

/**
 * Make the rows say `next`, oldest first, touching only what changed. An
 * entry keeps its row (and its place) while it stays behind the one before
 * it; an entry the engine moved to the end is given the next place.
 * Returns whether anything changed.
 */
export async function writeLedger(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  rows: readonly Doc<"forwardingEntries">[],
  next: readonly ForwardingEntry[],
): Promise<boolean> {
  const byKey = new Map<string, Doc<"forwardingEntries">>();
  for (const row of rows) {
    // Two rows for one key only an older write could leave: the later one stands.
    const held = byKey.get(keyOf(row));
    if (held !== undefined) await ctx.db.delete(held._id);
    byKey.set(keyOf(row), row);
  }
  let seq = rows.length === 0 ? 0 : rows[rows.length - 1]!.seq;
  let previous = -Infinity;
  let changed = false;
  for (const entry of next) {
    const row = byKey.get(keyOf(entry));
    byKey.delete(keyOf(entry));
    if (row !== undefined && row.seq > previous) {
      previous = row.seq;
      if (row.to !== entry.to || row.at !== entry.at) {
        await ctx.db.patch(row._id, { to: entry.to, at: entry.at });
        changed = true;
      }
      continue;
    }
    seq += 1;
    previous = seq;
    changed = true;
    if (row !== undefined) await ctx.db.patch(row._id, { seq, to: entry.to, at: entry.at });
    else await ctx.db.insert("forwardingEntries", { workspaceId, seq, from: entry.from, to: entry.to, kind: entry.kind, at: entry.at });
  }
  for (const row of byKey.values()) {
    await ctx.db.delete(row._id);
    changed = true;
  }
  return changed;
}

/** Record moves, in order, as the engine collapses and caps them; the files follow. */
export async function recordForwardingMoves(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  moves: readonly ForwardingMove[],
  now: number,
): Promise<void> {
  const cleaned = cleanMoves(moves) as ForwardingMove[];
  if (cleaned.length === 0) return;
  const rows = await ledgerRows(ctx.db, workspaceId);
  const next = addForwarding(ledgerOf(rows), cleaned, { now }).entries as ForwardingEntry[];
  if (await writeLedger(ctx, workspaceId, rows, next)) await markChanged(ctx, workspaceId, "forwarding");
}
