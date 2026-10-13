import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { mirrorSupported } from "./mirrorStore";

/**
 * The live head of each context's tree change log, for a device that keeps a
 * copy (phase 6 of `docs/decisions/app-and-console/convex-tree.md`).
 *
 * One subscription per context to `nodesFeed.head`. Its token moves when a
 * change this person may hear of lands, or the rules change, and
 * `useMirrorSync` catches up on that instead of waiting for its five-minute
 * pass. A context the Convex tree does not serve (not proved, or staff paused
 * the migration) has no token, and keeps the timed pass.
 *
 * A browser tab keeps no copy, so it subscribes to nothing: its sidebar is
 * already live (`useLiveTree`).
 */
export function useNodeFeed(workspaceIds: readonly string[] | undefined): ReadonlyMap<string, string> {
  const key = mirrorSupported() ? [...(workspaceIds ?? [])].sort().join(",") : "";
  const spec = useMemo(() => {
    const out: RequestForQueries = {};
    if (key === "") return out;
    for (const workspaceId of key.split(",")) {
      out[workspaceId] = {
        query: api.functions.nodesFeed.head,
        args: { workspaceId: workspaceId as Id<"workspaces"> },
      };
    }
    return out;
  }, [key]);
  const results = useQueries(spec) as Record<string, { token: string } | null | undefined | Error>;
  return useMemo(() => {
    const heads = new Map<string, string>();
    for (const [workspaceId, result] of Object.entries(results ?? {})) {
      // Loading, refused or not served: no token, and the timed pass stays on.
      if (result === null || result === undefined || result instanceof Error) continue;
      if (typeof result.token === "string") heads.set(workspaceId, result.token);
    }
    return heads;
  }, [results]);
}
