import { CONSOLE_CLIENT_NAME, toolNameOf } from "./agentKind";
import type { MapHub } from "./types";

/** One member row, as `listMembers` sends it. */
export type HubMember = { userId: string; name?: string; isMe: boolean };

/**
 * The all-workspaces hub from the console's data: you, how many people are
 * in each workspace with a few of their faces, and the AI tools you
 * connected that are at work right now, one per tool, with every workspace
 * it is working in. A tool sitting idle is not drawn at all.
 *
 * Only your own connections: an owner is shown everyone's grants, and a
 * colleague's Claude drawn beside you would read as yours. The app itself,
 * the console and the desktop app on your computers ("Context on
 * Seyis-MacBook-Pro", which records meetings), is your own hand, not a tool,
 * so it is left out.
 */
export function hubFrom(input: {
  you: string;
  contexts: ReadonlyArray<{ id: string; slug: string }>;
  clients: ReadonlyArray<{ name: string; context: string; mine: boolean; machine?: boolean }>;
  /** Members per workspace id; a workspace whose list has not come yet is left out. */
  members: ReadonlyMap<string, readonly HubMember[]>;
  /**
   * Your agents at work now, or at the playhead in a replay, by name and
   * workspace (`agentsAtWork`). A tool is drawn only while one of these is
   * it, and only to the workspaces it is working in (Dev2, 2026-10-12: "they
   * should only ever be shown when they are actively working in a workspace").
   */
  working: ReadonlyArray<{ name: string; workspaceId?: string }>;
}): MapHub {
  const idOf = new Map(input.contexts.map((c) => [`@${c.slug}`, c.id]));
  const workspaces: MapHub["workspaces"] = {};
  for (const [id, rows] of input.members) {
    workspaces[id] = {
      people: rows.length,
      faces: rows.filter((r) => !r.isMe).map((r) => r.name ?? r.userId),
    };
  }
  const busy = new Set(input.working.map((a) => `${a.workspaceId ?? ""}\n${toolNameOf(a.name)}`));
  const tools = new Map<string, { id: string; name: string; workspaceIds: string[] }>();
  for (const client of input.clients) {
    if (!client.mine || isAppClient(client)) continue;
    const workspaceId = idOf.get(client.context);
    if (workspaceId === undefined) continue;
    const name = toolNameOf(client.name);
    if (!busy.has(`${workspaceId}\n${name}`)) continue;
    const tool = tools.get(name) ?? { id: `agent:${name}`, name, workspaceIds: [] };
    if (!tool.workspaceIds.includes(workspaceId)) tool.workspaceIds.push(workspaceId);
    tools.set(name, tool);
  }
  return { you: input.you, workspaces, agents: [...tools.values()] };
}

/**
 * The app's own connection: the console, by the name only Context registers
 * under (`normalizeClientName` marks a stranger who tries it), or the desktop
 * app, by the flag the server derives (`isDesktopShellClient`). The name a
 * desktop install registers under is recognised there rather than here,
 * because a name read at this layer is a name a client chose for itself, and
 * what this decides is whether the map draws the thing at all.
 */
/**
 * How long after its last read or write an agent still counts as at work:
 * the gateway's own live window (`AGENT_ACTIVITY_WINDOW_MS` in
 * `apps/mcp/src/agentActivity.js`), so the middle of the map and the
 * sidebar's "working now" agree.
 */
export const AGENT_AT_WORK_MS = 5 * 60_000;

/**
 * Which of the map's actors are your own agents at work. Live, the gateway
 * marks the caller's own (`self`), and the last signal must be inside the
 * window; in a replay the actors are already the ones at the playhead, and an
 * event says nothing of whose it was, so every agent there counts.
 */
export function agentsAtWork(
  actors: ReadonlyArray<{ kind: "person" | "agent"; name: string; workspaceId?: string; self?: boolean; at: number }>,
  live: { now: number } | null,
): Array<{ name: string; workspaceId?: string }> {
  return actors
    .filter((a) => a.kind === "agent" && (live === null || (a.self === true && live.now - a.at <= AGENT_AT_WORK_MS)))
    .map((a) => ({ name: a.name, ...(a.workspaceId === undefined ? {} : { workspaceId: a.workspaceId }) }));
}

function isAppClient(client: { name: string; machine?: boolean }): boolean {
  return client.machine === true || client.name === CONSOLE_CLIENT_NAME;
}
