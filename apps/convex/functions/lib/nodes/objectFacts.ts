/**
 * Notes' facts from the workspace object, for the control plane's own readers (decided by the owner, 2026-11-02;
 * `docs/decisions/storage-and-credentials/facts-in-objects.md`): a List's or Board's front matter, the chaos score's
 * extras and the map's links. Where a workspace's notes live in its object, the object holds their text and reads
 * their facts from it the moment it is asked (`apps/mcp/src/workspaceStore/facts.js`), so these never lag a save.
 *
 * Every source here falls back to the control plane's own copy (`factSources.ts`, `linkTable.ts`) for whatever the
 * object does not answer: a workspace not on its object, an object that fails or has more changed notes than one ask
 * reads, or a path the object does not hold (a row whose push has not landed yet). The answers are unfiltered, as
 * the control plane's internal queries are: each caller judges every path with `canSee` itself.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { ChaosSource } from "../filesFns/chaosOps";
import type { PropSource } from "../filesFns/folderNotes";
import type { FileStore } from "../fileOps/store";
import { consoleWorkspaceClient } from "../workspaceObjects/door";
import { isFactNote, PROPS_AT_PATHS } from "./facts";
import type { LinkTable } from "./linkTable";
import { servedKeys } from "./manifestStore";

type Ctx = ActionCtx;
export type FactRows = (request: {
  ask: "props" | "links" | "chaos" | "candidates" | "linking" | "neighborRows";
  path?: string;
  paths?: string[];
  sources?: string[];
  names?: string[];
}) => Promise<Record<string, unknown>>;

/** The object's unfiltered facts, or `null` where the workspace's notes do not live in its object. */
export async function objectFactRows(ctx: Ctx, workspaceId: Id<"workspaces">): Promise<FactRows | null> {
  const home = await ctx.runQuery(internal.functions.workspaceObjectsRows.homeOf, { workspaceId }).catch(() => null);
  if (home !== "object") return null;
  const client = consoleWorkspaceClient(ctx, workspaceId, { caller: "facts" });
  if (client === null) return null;
  return async (request) => (await client.factRows(request)) as Record<string, unknown>;
}

/** Each note's props from the object; the paths it does not answer, from `fallback`. */
export function objectPropSource(rows: FactRows | null, fallback: PropSource): PropSource {
  if (rows === null) return fallback;
  return {
    rows: async (paths) => {
      const found = new Map<string, { version: string | null; encrypted: boolean; props: string | null }>();
      let missing = paths;
      try {
        for (let at = 0; at < paths.length; at += PROPS_AT_PATHS) {
          const answer = await rows({ ask: "props", paths: paths.slice(at, at + PROPS_AT_PATHS) });
          if (answer.served !== true || !Array.isArray(answer.props)) throw new Error("not served");
          for (const row of answer.props as Array<{ path: string; version: string | null; sealed: boolean; props: string | null }>) {
            found.set(row.path, { version: row.version, encrypted: row.sealed, props: row.props });
          }
        }
        missing = paths.filter((path) => !found.has(path));
      } catch {
        found.clear();
        missing = paths;
      }
      if (missing.length === 0) return found;
      for (const [path, row] of await fallback.rows(missing)) found.set(path, row);
      return found;
    },
  };
}

/** The chaos score's extras from the object; its history stays the control plane's (`nodeChaosDays`). */
export function objectChaosSource(rows: FactRows | null, fallback: ChaosSource): ChaosSource {
  if (rows === null) return fallback;
  return {
    ...fallback,
    extras: async () => {
      const answer = await rows({ ask: "chaos" }).catch(() => null);
      if (answer?.served !== true || !Array.isArray(answer.extras)) return await fallback.extras();
      const extras = answer.extras as Array<{ path: string; lines: number | null; exempt: boolean; review: boolean }>;
      return new Map(extras.map(({ path, ...extra }) => [path, extra]));
    },
  };
}

/** The map's link table from the object: the served rows' notes, and every link the object holds. */
export async function objectLinkTable(rows: FactRows | null, served: FileStore): Promise<LinkTable | null> {
  if (rows === null) return null;
  const answer = await rows({ ask: "links" }).catch(() => null);
  if (answer?.served !== true || !Array.isArray(answer.links)) return null;
  const links = answer.links as string[][];
  return {
    unparsed: typeof answer.unparsed === "number" ? answer.unparsed : 0,
    read: async () => ({ paths: (await servedKeys(served)).filter(isFactNote), links }),
  };
}

/**
 * These notes' props as the object holds them now, read at their current text: `sealed` and `props` (`propsOf` as
 * JSON) by path. `null` where the object is not asked or does not answer; a path it does not hold is absent, and
 * the caller keeps what the control plane's row says for it.
 */
export async function objectPropsAt(rows: FactRows | null, paths: readonly string[]): Promise<Map<string, { sealed: boolean; props: string | null }> | null> {
  if (rows === null) return null;
  const found = new Map<string, { sealed: boolean; props: string | null }>();
  const wanted = [...new Set(paths)];
  try {
    for (let at = 0; at < wanted.length; at += PROPS_AT_PATHS) {
      const answer = await rows({ ask: "props", paths: wanted.slice(at, at + PROPS_AT_PATHS) });
      if (answer.served !== true || !Array.isArray(answer.props)) return null;
      for (const row of answer.props as Array<{ path: string; sealed: boolean; props: string | null }>) {
        found.set(row.path, { sealed: row.sealed === true, props: row.props ?? null });
      }
    }
  } catch {
    return null;
  }
  return found;
}

/**
 * A move's link candidates from the object (`nodeFacts.candidates`' shape, unfiltered): the notes pointing at what
 * moved, and those whose links cannot be trusted. `undefined` where the object is not asked or does not answer, and
 * the caller asks the control plane.
 */
export async function objectCandidates(
  rows: FactRows | null,
  sources: string[],
  names: string[],
): Promise<{ pointing: string[]; unparsed: string[] } | null | undefined> {
  if (rows === null) return undefined;
  const answer = await rows({ ask: "candidates", sources, names }).catch(() => null);
  if (answer?.served !== true) return undefined;
  const candidates = answer.candidates as { pointing: string[]; unparsed: string[] } | null;
  return candidates === null ? null : { pointing: candidates.pointing, unparsed: candidates.unparsed };
}

/**
 * Which of `paths` hold links of their own, from the object (`nodeLinkSources.linking`'s answer, unfiltered), with
 * every note it cannot vouch for counted as linking. `undefined` where the object is not asked or does not answer,
 * and the caller asks the control plane.
 */
export async function objectLinking(rows: FactRows | null, paths: readonly string[]): Promise<string[] | undefined> {
  if (rows === null) return undefined;
  const answer = await rows({ ask: "linking", paths: [...paths] }).catch(() => null);
  if (answer?.served !== true || !Array.isArray(answer.linking)) return undefined;
  return answer.linking.filter((path): path is string => typeof path === "string");
}

/** A note's link rows as the object holds them now, in `nodeFacts.neighbors`' shape (unfiltered). */
export interface NeighborRows {
  present: boolean;
  current: boolean;
  links: Array<{ kind: "path" | "name"; target: string }>;
  byPath: string[];
  byName: string[];
}

/**
 * One note's neighbor rows from the object: its links, and the notes pointing at it by path and by bare name.
 * `undefined` where the object is not asked or does not answer, and the caller asks the control plane.
 */
export async function objectNeighborRows(rows: FactRows | null, path: string): Promise<NeighborRows | undefined> {
  if (rows === null) return undefined;
  const answer = await rows({ ask: "neighborRows", path }).catch(() => null);
  if (answer?.served !== true || answer.rows === null || typeof answer.rows !== "object") return undefined;
  return answer.rows as NeighborRows;
}
