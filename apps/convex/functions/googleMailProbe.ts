/**
 * Whether each connected Gmail can be read live the way Tex reads it, as
 * counts only.
 *
 * Run from the `Google sync health` workflow against production, whose log is
 * public: so it answers with our own fixed codes and Google's status numbers
 * and reason words, counted, and never a row id, an address, a workspace or a
 * word of mail. It does what a person's mail search does for one mailbox
 * (`lib/gatewayRoutes/personMail.ts`): mint the AI's token, list one message
 * id from the last week, and read that message's headers, and says where it
 * stopped. Nothing it reads is kept or printed.
 *
 * Why it exists: on 2026-11-14 one of a person's four Gmails failed every live
 * search for an afternoon, and the only record was "did not answer".
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";
import type { MintOutcome } from "./lib/googleConnect/syncTokens";
import { gmailFailureCode } from "./lib/gatewayRoutes/personMail";
import { getMessageHeaders, listMessageIds, LIVE_RETRY_MS } from "../../mcp/src/communications/gmailSync.js";
import { timeoutFetch } from "./lib/filesFns/forwardSyncSupport";

/** At most this many mailboxes a run: one list and one read each. */
const PROBE_LIMIT = 100;

function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

type ProbeRow = { connectionId: Id<"googleConnections">; readable: boolean; health: string; agentGrant: boolean; split: boolean };

/** The live Gmail rows a mail search would ask, with what decides how they are read. */
export const probeRows = internalQuery({
  args: {},
  returns: v.array(v.object({ connectionId: v.id("googleConnections"), readable: v.boolean(), health: v.string(), agentGrant: v.boolean(), split: v.boolean() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("googleConnections").take(1_000);
    return rows
      .filter((row) => row.disconnectedAt === undefined && row.products.includes("gmail") && row.gmail !== undefined)
      .slice(0, PROBE_LIMIT)
      .map((row) => ({
        connectionId: row._id,
        readable: canReadProduct("gmail", aiScopesOf(row)),
        health: row.health ?? "unset",
        agentGrant: row.agentGrant !== undefined,
        split: row.consentPlan === "split",
      }));
  },
});

/** One mailbox, read as a search reads it: the fixed code for where it stopped, or `ok`. */
async function probeOne(ctx: ActionCtx, connectionId: Id<"googleConnections">): Promise<string> {
  const outcome: MintOutcome = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, { connectionId, role: "agent" as const });
  if (outcome.kind !== "minted") return outcome.kind === "refused" ? `token_${outcome.why ?? "refused"}` : `token_${outcome.kind}`;
  const live = { fetchImpl: timeoutFetch, accessToken: outcome.accessToken, delaysMs: LIVE_RETRY_MS };
  let ids: string[];
  try {
    ({ ids } = await listMessageIds({ ...live, query: "newer_than:7d", pageToken: undefined, maxResults: 1 }));
  } catch (error) {
    return `list_${gmailFailureCode(error)}`;
  }
  if (ids.length === 0) return "ok_empty";
  try {
    await getMessageHeaders({ ...live, id: ids[0]! });
    return "ok";
  } catch (error) {
    return `get_${gmailFailureCode(error)}`;
  }
}

export const report = internalAction({
  args: {},
  returns: v.object({ mailboxes: v.number(), outcomes: v.record(v.string(), v.number()) }),
  handler: async (ctx) => {
    const rows: ProbeRow[] = await ctx.runQuery(internal.functions.googleMailProbe.probeRows, {});
    const outcomes: Record<string, number> = {};
    for (const row of rows) {
      // Which grant and state it is in, beside where its read stopped: `agent`/`standard`, `split` or not, and its health word.
      const shape = `${row.agentGrant ? "agentGrant" : "noAgentGrant"}:${row.split ? "split" : "unsplit"}:${row.health}`;
      if (!row.readable || row.health === "reconnect_required") {
        bump(outcomes, `${shape}:notAsked`);
        continue;
      }
      let code: string;
      try {
        code = await probeOne(ctx, row.connectionId);
      } catch (error) {
        code = `probe_${error instanceof Error ? error.name : "error"}`;
      }
      bump(outcomes, `${shape}:${code}`);
    }
    return { mailboxes: rows.length, outcomes };
  },
});
