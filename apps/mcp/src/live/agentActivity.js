/** Which tool calls show as agent activity on a note, and recording them. Moved out of `src/index.js`. */

import { AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL, agentActivityKey } from "../agentActivity.js";
import { isConsoleActor, presenceActor, presenceClientKey } from "./presence.js";

/**
 * Which tool calls count as an agent reading, writing or moving a note.
 *
 * A `write` becomes `create` or `edit`, and a `move` the notes it moved, from
 * what the handler said beside its answer (`live/activityHint.js`). A move
 * whose handler said nothing — "source and destination are the same", a dry
 * run — records nothing.
 */
export const AGENT_ACTIVITY_TOOLS = new Map([
  ["read_note", "read"],
  ["fetch", "read"],
  ["write_note", "write"],
  ["move_note", "move"],
  ["move_notes", "move"],
  ["move_folder", "move"],
  ["archive_note", "move"],
]);

/**
 * Tell this workspace's activity log about one call's reads, writes or moves.
 *
 * `entries` is `[{kind, path, from?}]`, one per note. Behind the response and
 * never in front of it, and not at all on a host that cannot defer: a dot in
 * somebody's sidebar is not worth a subrequest nothing keeps alive, the trade
 * `reportUsage` makes for the same reason. Keyed by the workspace this store
 * reaches, so a cross-context call marks the context it was routed to. One
 * request per call however many notes it moved, and at most
 * `AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL` of them.
 */
export function recordAgentActivity(store, entries) {
  const rooms = store.presenceRooms;
  const workspaceId = store.actor?.workspaceId;
  if (!rooms || typeof workspaceId !== "string" || !workspaceId) return;
  if (isConsoleActor(store.actor) || typeof store.defer !== "function") return;
  if (!Array.isArray(entries) || entries.length === 0) return;
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
        body: JSON.stringify({ entries: entries.slice(0, AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL), actor }),
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
