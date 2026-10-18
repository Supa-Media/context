/**
 * Settings that name a folder follow it when it moves, as pins do
 * (`placesFollow.ts`): where meetings land, where emailed notes land, and
 * where each Google service writes. Built-in folders can be renamed and
 * moved (owner, 2026-10-18; `folderJobs.ts`), so a setting left naming the
 * old path would make the next email or meeting recreate the folder there.
 *
 * Only a setting at `from` or under it changes. An unset setting already
 * means "the default under the Inbox", and `canonicalJobPath` carries that
 * default to wherever the Inbox is now, so it is left unset.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

/** `value` with `from` swapped for `to` when it names `from` or a path under it, else null. Keeps a trailing slash. */
export function followedPath(value: string | undefined, from: string, to: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  const slash = value.endsWith("/");
  const bare = value.replace(/\/+$/, "");
  if (bare === from) return slash ? `${to}/` : to;
  if (bare.startsWith(`${from}/`)) return `${to}${bare.slice(from.length)}${slash ? "/" : ""}`;
  return null;
}

const GOOGLE_SERVICES = ["gmail", "calendar", "chat"] as const;

export async function followFolderSettings(ctx: MutationCtx, workspaceId: Id<"workspaces">, from: string, to: string): Promise<void> {
  const workspace = await ctx.db.get(workspaceId);
  const meetings = followedPath(workspace?.meetingsFolder, from, to);
  if (workspace !== null && meetings !== null) await ctx.db.patch(workspaceId, { meetingsFolder: meetings });

  const ingestion = await ctx.db
    .query("ingestionSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(4);
  for (const row of ingestion) {
    const target = followedPath(row.targetFolder, from, to);
    if (target !== null) await ctx.db.patch(row._id, { targetFolder: target });
  }

  const connections = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(50);
  for (const row of connections) {
    const patch: Record<string, unknown> = {};
    for (const service of GOOGLE_SERVICES) {
      const settings = row[service];
      if (settings === undefined) continue;
      const destination = followedPath(settings.destinationFolder, from, to);
      if (destination !== null) patch[service] = { ...settings, destinationFolder: destination };
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
  }
}
