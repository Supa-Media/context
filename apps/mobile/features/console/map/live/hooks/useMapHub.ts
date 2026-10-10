import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useMemo } from "react";
import { EMPTY_QUERY_SPEC } from "../../../querySpec";
import type { ConsoleData } from "../../../types";
import { hubFrom, type HubMember } from "../mapHub";
import type { MapHub } from "../types";

/**
 * The all-workspaces hub for the map, or null when it is not drawn (one
 * workspace, the demo, the screenshot fixture). Members are asked for only
 * while it is: one `listMembers` per workspace, as `useQueries`, so a list
 * that fails leaves that workspace's people line out rather than the page.
 */
export function useMapHub(data: ConsoleData, enabled: boolean): MapHub | null {
  const ids = useMemo(() => (enabled ? data.contexts.map((c) => c.id) : []), [enabled, data.contexts]);
  const key = ids.join(",");
  const spec = useMemo<RequestForQueries>(() => {
    if (key === "") return EMPTY_QUERY_SPEC;
    const out: RequestForQueries = {};
    for (const id of key.split(",")) {
      out[id] = { query: api.functions.workspaces.listMembers, args: { workspaceId: id as Id<"workspaces"> } };
    }
    return out;
  }, [key]);
  const results = useQueries(spec);
  // `useQueries` and the console hand back new objects every render; the map
  // redraws its whole model when this changes, so it changes only when what
  // it says does.
  const members = new Map<string, HubMember[]>();
  for (const id of ids) {
    const rows = results[id];
    if (Array.isArray(rows)) members.set(id, rows as HubMember[]);
  }
  const hub = enabled ? hubFrom({ you: data.viewer.name, contexts: data.contexts, clients: data.clients, members }) : null;
  const said = JSON.stringify(hub);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => hub, [said]);
}
