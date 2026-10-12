import { CONSOLE_CLIENT_NAME, toolNameOf } from "./agentKind";
import type { MapHub } from "./types";

/** One member row, as `listMembers` sends it. */
export type HubMember = { userId: string; name?: string; isMe: boolean };

/**
 * The all-workspaces hub from the console's data: you, how many people are
 * in each workspace with a few of their faces, and the AI tools you
 * connected, one per tool, with every workspace it reaches.
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
}): MapHub {
  const idOf = new Map(input.contexts.map((c) => [`@${c.slug}`, c.id]));
  const workspaces: MapHub["workspaces"] = {};
  for (const [id, rows] of input.members) {
    workspaces[id] = {
      people: rows.length,
      faces: rows.filter((r) => !r.isMe).map((r) => r.name ?? r.userId),
    };
  }
  const tools = new Map<string, { id: string; name: string; workspaceIds: string[] }>();
  for (const client of input.clients) {
    if (!client.mine || isAppClient(client)) continue;
    const workspaceId = idOf.get(client.context);
    if (workspaceId === undefined) continue;
    const name = toolNameOf(client.name);
    const tool = tools.get(name) ?? { id: `agent:${name}`, name, workspaceIds: [] };
    if (!tool.workspaceIds.includes(workspaceId)) tool.workspaceIds.push(workspaceId);
    tools.set(name, tool);
  }
  return { you: input.you, workspaces, agents: [...tools.values()] };
}

/**
 * The desktop app's own connection, by the flag the server reads from its
 * declared software id, or by the name it registers under for a desktop
 * install from before that flag. Only decides what the map draws.
 */
const DESKTOP_NAME = /^Context on /;

function isAppClient(client: { name: string; machine?: boolean }): boolean {
  return client.machine === true || client.name === CONSOLE_CLIENT_NAME || DESKTOP_NAME.test(client.name);
}
