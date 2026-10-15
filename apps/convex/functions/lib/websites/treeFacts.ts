/**
 * A website's answers from the tree: which notes exist and may be seen, and
 * their front matter's website flags (Dev2, 2026-10-14: names, existence and
 * front matter come from the tree; storage is read only to open a note's body).
 *
 * Every helper answers `null` when the tree cannot answer (not served, a
 * query failed). Callers fail safe on that: nothing is published, listed or
 * drawn from a guess, and no bucket listing stands in for the tree.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";

/** Paths per tree query; the tree's own limit is 100. */
const ROWS_PER_QUERY = 100;

/** A note's website flags as the tree's facts hold them. */
export type RowFacts = {
  properties: Record<string, unknown>;
  inlineTags: string[];
  heading: string | null;
  site: { draft: boolean; restricts: boolean };
};

/** A note the tree knows, at the publication clearance, with its facts when they can be trusted. */
export type TreeRow = {
  etag: string | null;
  updatedAt: number | null;
  sealed: boolean;
  facts: RowFacts | null;
};

export function factsOf(props: string | null): RowFacts | null {
  if (props === null) return null;
  try {
    const parsed = JSON.parse(props) as Partial<RowFacts>;
    const site = parsed.site;
    if (typeof site?.draft !== "boolean" || typeof site.restricts !== "boolean") return null;
    return {
      properties: parsed.properties ?? {},
      inlineTags: Array.isArray(parsed.inlineTags) ? parsed.inlineTags : [],
      heading: typeof parsed.heading === "string" ? parsed.heading : null,
      site,
    };
  } catch {
    return null;
  }
}

/**
 * Each path the publication clearance can see and the tree holds, by path. A
 * path absent from the map is absent or held back. Facts are null where they
 * were read at another version, are sealed, or predate the website flags.
 */
export async function treeRows(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  paths: readonly string[],
): Promise<Map<string, TreeRow> | null> {
  const wanted = [...new Set(paths)];
  const rows = new Map<string, TreeRow>();
  for (let at = 0; at < wanted.length; at += ROWS_PER_QUERY) {
    const answer = await ctx
      .runQuery(internal.functions.nodeFacts.publishedRows, {
        workspaceId,
        paths: wanted.slice(at, at + ROWS_PER_QUERY),
      })
      .catch(() => null);
    if (answer === null) return null;
    for (const row of answer) {
      rows.set(row.path, {
        etag: row.etag,
        updatedAt: row.uploaded,
        sealed: row.sealed,
        facts: row.current && !row.sealed ? factsOf(row.props) : null,
      });
    }
  }
  return rows;
}

/**
 * The paths among `paths` the tree holds as a live note `clearance` may see:
 * existence only, never a note's bytes. Null when the tree cannot say.
 */
export async function visibleTreePaths(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  clearance: Clearance,
  paths: readonly string[],
): Promise<Set<string> | null> {
  const wanted = [...new Set(paths)];
  const found = new Set<string>();
  for (let at = 0; at < wanted.length; at += ROWS_PER_QUERY) {
    const answer = await ctx
      .runQuery(internal.functions.nodeFacts.visibleNotes, {
        workspaceId,
        paths: wanted.slice(at, at + ROWS_PER_QUERY),
        scope: clearance.scope,
        names: [...clearance.names],
      })
      .catch(() => null);
    if (answer === null) return null;
    for (const path of answer) found.add(path);
  }
  return found;
}
