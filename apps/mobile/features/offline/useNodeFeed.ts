import { useEffect, useMemo, useState } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { mirrorSupported } from "./mirrorStore";
import { objectHeads } from "./objectHeads";
import { useReachability } from "./reachability";
import { useConsoleGrant } from "../agent/useConsoleGrant";
import { gatewayOriginFrom } from "../meetings/gateway";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { openObjectTree } from "../console/files/fileBrowser/objectTree";

/**
 * The live head of each context, for a device that keeps a copy.
 *
 * **From the workspace's object first** (decided by the owner, 2026-11-06: nothing about a note waits on the
 * control plane, and the object pushes changes rather than anybody polling; `objectHeads.ts`). The object sends a
 * head over its tree socket that moves when anything this person may see there changes, a note's text and so its
 * mail included, and `useMirrorSync` catches up on that.
 *
 * A workspace whose object does not serve it (not switched over, or unreachable) keeps the control plane's change
 * log: one subscription to `nodesFeed.head` (phase 6 of `docs/decisions/app-and-console/convex-tree.md`), whose token
 * moves when a change this person may hear of lands. A context with neither has no token, and keeps the timed pass.
 *
 * A browser tab keeps no copy, so it subscribes to nothing: its sidebar is already live (`useLiveTree`).
 */
export function useNodeFeed(workspaceIds: readonly string[] | undefined): ReadonlyMap<string, string> {
  const supported = mirrorSupported();
  const key = supported ? [...(workspaceIds ?? [])].sort().join(",") : "";
  const [fromObject, setFromObject] = useState<ReadonlyMap<string, string>>(new Map());

  const reachability = useReachability();
  const mint = useConsoleGrant();
  const gatewayOrigin = gatewayOriginFrom(MCP_ENDPOINT);
  const online = reachability === "online";
  useEffect(() => {
    if (key === "" || !online || gatewayOrigin === null) return;
    const heads = objectHeads(
      ({ workspaceId, ...events }) =>
        openObjectTree({
          ...events,
          gatewayOrigin,
          token: async (refresh) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken,
        }),
      (workspaceId, head) =>
        setFromObject((held) => {
          if ((held.get(workspaceId) ?? null) === head) return held;
          const next = new Map(held);
          if (head === null) next.delete(workspaceId);
          else next.set(workspaceId, head);
          return next;
        }),
    );
    heads.follow(key.split(","));
    return () => {
      heads.close();
      setFromObject(new Map());
    };
  }, [key, online, gatewayOrigin, mint]);

  // The control plane's log, only for a workspace its object does not serve.
  const convexKey = key === "" ? "" : key.split(",").filter((workspaceId) => !fromObject.has(workspaceId)).join(",");
  const spec = useMemo(() => {
    const out: RequestForQueries = {};
    if (convexKey === "") return out;
    for (const workspaceId of convexKey.split(",")) {
      out[workspaceId] = {
        query: api.functions.nodesFeed.head,
        args: { workspaceId: workspaceId as Id<"workspaces"> },
      };
    }
    return out;
  }, [convexKey]);
  const results = useQueries(spec) as Record<string, { token: string } | null | undefined | Error>;
  return useMemo(() => {
    const heads = new Map<string, string>(fromObject);
    for (const [workspaceId, result] of Object.entries(results ?? {})) {
      if (heads.has(workspaceId)) continue;
      // Loading, refused or not served: no token, and the timed pass stays on.
      if (result === null || result === undefined || result instanceof Error) continue;
      if (typeof result.token === "string") heads.set(workspaceId, result.token);
    }
    return heads;
  }, [results, fromObject]);
}
