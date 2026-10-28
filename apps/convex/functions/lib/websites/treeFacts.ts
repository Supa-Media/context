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

type ReadNote = {
  path: string;
  text: string;
  etag: string;
  updatedAt?: number;
};

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

export async function readBatches(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  scope: "private" | "team",
  paths: readonly string[],
): Promise<Map<string, ReadNote>> {
  const pending = [...new Set(paths)];
  const notes = new Map<string, ReadNote>();
  let passes = 0;
  while (pending.length > 0) {
    // `readMany` guarantees its first path makes progress even at the byte cap.
    if (passes++ > paths.length + 1)
      throw new Error("folder list read did not progress");
    const batch = pending.splice(0, 50);
    const result = await ctx.runAction(
      internal.functions.files.runFileOperation,
      {
        workspaceId,
        scope,
        grantedNames: [],
        operation: { kind: "readMany" as const, paths: batch },
      },
    );
    if (result.kind !== "notes") throw new Error("folder list read failed");
    const deferred: string[] = [];
    for (const item of result.results) {
      if (item.outcome === "deferred") {
        deferred.push(item.path);
      } else if (item.outcome === "read") {
        notes.set(item.path, {
          path: item.path,
          text: item.note.text,
          etag: item.note.etag,
          ...(item.note.updatedAt === undefined
            ? {}
            : { updatedAt: item.note.updatedAt }),
        });
      }
    }
    pending.unshift(...deferred);
  }
  return notes;
}

/**
 * `treeRows`, after the facts of any row that lags its note have been read.
 *
 * The facts fill runs after a change, not with it, and a write through the
 * gateway (an agent, the live editor) waits for the next pass, up to the
 * quarter-hour sweep. A website that took "no current facts" as "not
 * published" dropped a just-edited note from its lists and its stylesheet
 * from every page until then (reported 2026-10-28). So a lagging row runs one
 * fill pass here, and the tree is asked again: the notes are still opened only
 * by the fill, and a row still lagging after it (another pass holds the fill,
 * or the note changed again while it read) is left out as before.
 */
export async function currentRows(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  paths: readonly string[],
): Promise<Map<string, TreeRow> | null> {
  const rows = await treeRows(ctx, workspaceId, paths);
  if (rows === null) return null;
  const lagging = [...rows].filter(([, row]) => row.facts === null && !row.sealed).map(([path]) => path);
  if (lagging.length === 0) return rows;
  const filled = await ctx
    .runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesFactFill" },
    })
    .catch(() => null);
  if (filled === null) return rows;
  const again = await treeRows(ctx, workspaceId, lagging);
  if (again === null) return rows;
  for (const [path, row] of again) rows.set(path, row);
  return rows;
}
