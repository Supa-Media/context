/**
 * Every app this deployment connects, and where one person stands in each:
 * what Tex reads before reaching for a browser (`connectionApps.appsForPerson`)
 * and what Settings lists with a Connect or Disconnect button
 * (`connectionSettings.myApps`). Both read this one list, so the two never
 * disagree about what a person has connected.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { PROVIDERS, providerAvailable } from "../providers/registry";
import type { ProviderId } from "../providers/ids";
import { TEXTS_GROUP_CLIENT_ID, mayConnect } from "./links";

export type AppState = "connected" | "reconnect" | "not_connected" | "not_available";

export type CatalogEntry = {
  app: ProviderId;
  name: string;
  about: string;
  via: "api" | "mcp";
  state: AppState;
  account?: string;
  connectionId?: Id<"providerConnections">;
};

/**
 * One line per available app. Only the person's own connection counts, made
 * in their personal workspace; from a group chat, or anywhere they may not
 * connect, every app reads `not_available`.
 */
export async function appCatalog(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  clientId: string,
): Promise<CatalogEntry[]> {
  const canConnect = clientId !== TEXTS_GROUP_CLIENT_ID && (await mayConnect(ctx, workspaceId, userId)) !== null;
  const rows = canConnect
    ? (await ctx.db
        .query("providerConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .take(50)).filter((row) => row.scope === "personal" && row.connectedBy === userId)
    : [];
  const out: CatalogEntry[] = [];
  for (const spec of Object.values(PROVIDERS)) {
    if (spec === undefined || !providerAvailable(spec)) continue;
    const row = rows.find((r) => r.provider === spec.id);
    out.push({
      app: spec.id,
      name: spec.name,
      about: spec.about,
      via: spec.kind === "mcp" ? "mcp" : "api",
      state: !canConnect
        ? "not_available"
        : row === undefined
          ? "not_connected"
          : row.reconnectRequiredAt !== undefined
            ? "reconnect"
            : "connected",
      ...(row === undefined ? {} : { account: row.externalTeamName, connectionId: row._id }),
    });
  }
  return out;
}
