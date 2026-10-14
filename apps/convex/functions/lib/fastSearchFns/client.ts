/**
 * A client for one context's fast-search database (D1), for the credential
 * barrier's projection pass and search (`filesFns/fileOperationBarrier.ts`).
 *
 * Until phase 7 of `docs/decisions/app-and-console/convex-tree.md` this lived
 * beside the D1 copy of the file tree, which also read it; the tree, its
 * links, its front matter and the chaos history are the Convex tree's now,
 * and the database holds search alone.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
// The gateway's D1 wire, imported rather than ported: `apps/mcp` targets the
// Workers runtime, which is Convex's runtime too. It holds the write token for
// the life of one call and puts it in exactly one place, an `Authorization`
// header.
import { createD1Client } from "../../../../mcp/src/search/d1/client.js";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../d1";
import type { ProjectionClient } from "../fileOps";

/**
 * A client for this context's search database, given a target the caller has
 * already accepted. `null` for a deployment with no Cloudflare credential.
 * Ours, not a customer's: `appSecrets` holds this deployment's own
 * integration credentials. Both or neither secret, as `provisionIndex` reads
 * them.
 */
export async function searchDatabaseClient(
  ctx: ActionCtx,
  target: { databaseId: string; state: string },
): Promise<ProjectionClient | null> {
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_TOKEN_SECRET,
  });
  const accountId = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_ACCOUNT_SECRET,
  });
  if (
    typeof apiToken !== "string" ||
    apiToken.length === 0 ||
    typeof accountId !== "string" ||
    accountId.length === 0
  ) {
    return null;
  }
  // No `fetchImpl`: the client resolves `globalThis.fetch` per call and
  // carries its own deadline.
  return createD1Client({
    databaseId: target.databaseId,
    accountId,
    apiToken,
    state: target.state,
  }) as ProjectionClient;
}
