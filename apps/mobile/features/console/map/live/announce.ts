import { agentActivityQuery } from "../../agents/agentActivity";

/**
 * What this console tells the gateway about its own person, on the poll it
 * already makes (`docs/decisions/gateway-protocol/live-map-feed.md`): which
 * note they have open, and a create or a move they just finished in the
 * console, which no tool call reports.
 *
 * Written where the console knows it (the open note, the file actions) and
 * read by whichever poll for that workspace goes next — the sidebar's half
 * minute or the map's few seconds. The gateway checks every path against the
 * person's own access and that the change happened, so nothing here is a way
 * to claim anything; it is only a way to be drawn.
 */

type Did = { kind: "create"; path: string } | { kind: "move"; from: string; to: string };

const open = new Map<string, { path: string; doing: "read" | "edit" }>();
const dids = new Map<string, Did[]>();

/** The note this person has open in `workspaceId`, or `null` for none. */
export function announceOpenNote(workspaceId: string | null, path: string | null, doing: "read" | "edit" = "read"): void {
  if (workspaceId === null) return;
  // One open note per console: opening one here closes whatever was open anywhere.
  open.clear();
  if (path !== null && path !== "") open.set(workspaceId, { path, doing });
}

/** A create or a move the console finished. Notes only: a folder is not a dot on the map. */
export function announceDid(workspaceId: string | null, did: Did): void {
  if (workspaceId === null) return;
  const paths = did.kind === "create" ? [did.path] : [did.from, did.to];
  if (!paths.every((path) => path.endsWith(".md"))) return;
  const list = dids.get(workspaceId) ?? [];
  list.push(did);
  // A burst bigger than this is a bulk move, which the next listing shows anyway.
  while (list.length > 20) list.shift();
  dids.set(workspaceId, list);
}

/**
 * The query string for the next poll of `workspaceId`, and `restore` to put an
 * announcement back when that poll fails. One `did` per request: the route
 * takes one.
 */
export function takeAnnouncement(workspaceId: string, since?: number | null): { query: string; restore: () => void } {
  const note = open.get(workspaceId) ?? null;
  const list = dids.get(workspaceId);
  const did = list?.shift() ?? null;
  const query = agentActivityQuery({ since: since ?? null, note: note?.path ?? null, doing: note?.doing ?? "read", did });
  return {
    query,
    restore: () => {
      if (did === null) return;
      const back = dids.get(workspaceId) ?? [];
      back.unshift(did);
      dids.set(workspaceId, back);
    },
  };
}

/** For tests: forget everything. */
export function resetAnnouncements(): void {
  open.clear();
  dids.clear();
}
