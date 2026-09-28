/** Which tool calls show as agent activity on a note, and recording one. Moved verbatim out of `src/index.js`. */

import { agentActivityKey } from "../agentActivity.js";
import { isConsoleActor, presenceActor, presenceClientKey } from "./presence.js";

/** Which tool calls count as an agent reading or writing a note. */
export const AGENT_ACTIVITY_TOOLS = new Map([
  ["read_note", "read"],
  ["fetch", "read"],
  ["write_note", "write"],
]);

/**
 * Tell this workspace's activity log about one read or write.
 *
 * Behind the response and never in front of it, and not at all on a host
 * that cannot defer: a dot in somebody's sidebar is not worth a subrequest
 * nothing keeps alive, the trade `reportUsage` makes for the same reason.
 * Keyed by the workspace this store reaches, so a cross-context call marks
 * the context it was routed to.
 */
export function recordAgentActivity(store, kind, path) {
  const rooms = store.presenceRooms;
  const workspaceId = store.actor?.workspaceId;
  if (!rooms || typeof workspaceId !== "string" || !workspaceId) return;
  if (isConsoleActor(store.actor) || typeof store.defer !== "function") return;
  const run = async () => {
    try {
      const grantId = store.actor?.grantId;
      const clientId = store.actor?.clientId;
      const userId = store.actor?.userId;
      if (
        typeof grantId !== "string" || !grantId ||
        typeof clientId !== "string" || !clientId ||
        typeof userId !== "string" || !userId
      ) return;
      const shown = await presenceActor(store.actor);
      const actor = {
        ...shown,
        // A registered client can serve several accounts. Activity is one
        // grant, not one client, or two people's Claude calls collapse into a
        // single row whose name changes with the newest event.
        id: await presenceClientKey(`activity:${grantId}:${clientId}`),
        // Opaque and compared only by the route. This lets the console say
        // which activity belongs to its viewer without publishing a user id.
        owner: await presenceClientKey(`person:${userId}`),
      };
      if (!actor.id) return;
      const room = rooms.get(rooms.idFromName(agentActivityKey(workspaceId)));
      await room.fetch("https://presence.invalid/activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, kind, actor }),
      });
    } catch {
      // A missed mark is a quieter sidebar. The call already succeeded.
    }
  };
  try {
    store.defer(run());
  } catch {
    // A host whose `waitUntil` refuses the work simply does not record.
  }
}
