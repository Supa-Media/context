/**
 * The folders on screen, kept live from Convex (phase 2 of the tree's move
 * into Convex, `docs/decisions/app-and-console/convex-tree.md`).
 *
 * The root, every expanded folder and the folder being viewed are subscribed
 * to `nodesListing.listFolder`. When anybody changes one of them (a
 * colleague, an agent, another tab of this person's), Convex sends the new
 * listing and it lands here as the server's answer for that folder, with no
 * walk of the bucket and no "something changed" hint to chase.
 *
 * `null` from the server means the tree does not serve this workspace yet (or
 * staff paused it), and then nothing here does anything: the console keeps
 * reading the bucket as it always has. `served` says which, so the caller can
 * stop asking for bucket walks when the tree is answering.
 *
 * A refusal (membership taken away) clears the folder, for the reason
 * `refresh` gives: a listing kept after a refusal shows what was withheld.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../../querySpec";
import { parentPath } from "../paths";
import type { FolderListing } from "../types";
import type { Listings } from "./types";

/** Folders subscribed at once: a bound on sockets' work, far above what a tree shows. */
export const LIVE_FOLDERS = 40;

/**
 * Which folders to keep live: the root, the folder being viewed (or the folder
 * of the note being viewed), then expanded folders shallowest first, up to
 * `LIVE_FOLDERS`. Sorted, so the same set is the same spec.
 */
export function liveFolders(expanded: ReadonlySet<string>, selected: string | null, selectedIsFolder: boolean): string[] {
  const picked = new Set<string>([""]);
  if (selected !== null) picked.add(selectedIsFolder ? selected : parentPath(selected));
  const byDepth = [...expanded].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  for (const folder of byDepth) {
    if (picked.size >= LIVE_FOLDERS) break;
    picked.add(folder);
  }
  return [...picked].sort();
}

interface LiveTreeDeps {
  workspaceId: Id<"workspaces"> | null;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  listings: Listings;
  /** Lay one server answer over the listings, as `refresh` does (`null` with `refused` clears it). */
  commitLive: (folder: string, page: FolderListing | null, refused: boolean) => void;
  offline: boolean;
}

export function useLiveTree(deps: LiveTreeDeps): { served: boolean } {
  const { workspaceId, expanded, selectedPath, listings, commitLive, offline } = deps;
  const selectedIsFolder = selectedPath !== null && listings[selectedPath] !== undefined;
  const key = useMemo(
    () => liveFolders(expanded, selectedPath, selectedIsFolder).join("\n"),
    [expanded, selectedPath, selectedIsFolder],
  );
  const spec = useMemo(() => {
    if (workspaceId === null || offline) return EMPTY_QUERY_SPEC;
    const queries: Record<string, { query: typeof api.functions.nodesListing.listFolder; args: { workspaceId: Id<"workspaces">; path: string } }> = {};
    for (const path of key.split("\n")) {
      queries[`f:${path}`] = { query: api.functions.nodesListing.listFolder, args: { workspaceId, path } };
    }
    return queries;
  }, [workspaceId, offline, key]);
  const results = useQueries(spec) as Record<string, FolderListing | null | undefined | Error>;

  // What was last laid down per folder, so an unchanged answer redraws nothing.
  const applied = useRef<{ workspaceId: string | null; pages: Map<string, string> }>({ workspaceId: null, pages: new Map() });
  if (applied.current.workspaceId !== workspaceId) applied.current = { workspaceId, pages: new Map() };

  useEffect(() => {
    for (const [name, result] of Object.entries(results)) {
      if (!name.startsWith("f:") || result === undefined || result === null) continue;
      const folder = name.slice(2);
      if (result instanceof Error) {
        if (applied.current.pages.get(folder) === "refused") continue;
        applied.current.pages.set(folder, "refused");
        commitLive(folder, null, true);
        continue;
      }
      const page = withoutKind(result);
      const seen = JSON.stringify(page);
      if (applied.current.pages.get(folder) === seen) continue;
      applied.current.pages.set(folder, seen);
      commitLive(folder, page, false);
    }
  }, [results, commitLive]);

  const root = results["f:"];
  return { served: root !== undefined && root !== null && !(root instanceof Error) };
}

/** The listing as `listFiles` hands it to the console: the result's `kind` tag dropped. */
function withoutKind(result: FolderListing & { kind?: string }): FolderListing {
  const { kind: _kind, ...page } = result;
  return page;
}
