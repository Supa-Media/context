/** Which tool calls show as agent activity on a note, and recording one. Moved verbatim out of `src/index.js`. */

import { agentActivityKey } from "../agentActivity.js";
import { isConsoleActor, presenceActor } from "./presence.js";

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
      const actor = await presenceActor(store.actor);
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
