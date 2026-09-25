/**
 * What the Connections and Tools-live steps draw, from facts the control plane
 * and the gateway already report.
 *
 * No new backend: a client is **connected** once one of its grants has been
 * used (`lastUsedAt`, which the gateway stamps on every authenticated call),
 * **waiting** while it holds a grant it has not used yet, and **not
 * connected** otherwise. The event tail is the agent-activity log the console
 * already polls. Pure, so every one of those rules is a test rather than a
 * judgement made in a component.
 */

import { providerIdForClientName } from "../console/clients/providers";
import type { AgentActivityView } from "../console/agents/agentActivity";
import type { ClientRow, ClientStatus } from "./redesign/ConnectionsStep";
import type { LiveEvent } from "./redesign/ToolsLiveStep";

/** The console's own grant. It is the person's own hand, not a tool of theirs. */
export const CONSOLE_CLIENT_ID = "context_console";

/** The fields of `grants.listGrants` these rules read. */
export interface GrantFacts {
  clientId: string;
  clientName?: string | null;
  status: string;
  lastUsedAt?: number | null;
}

/** The rows the step lists, in order, and which provider each one is. */
const ROWS: ReadonlyArray<{ key: ClientRow["key"]; name: string; provider: string; hasGuide: boolean }> = [
  { key: "claude-desktop", name: "Claude", provider: "claude", hasGuide: true },
  { key: "chatgpt", name: "ChatGPT", provider: "chatgpt", hasGuide: true },
  { key: "cursor", name: "Cursor", provider: "cursor", hasGuide: false },
  { key: "codex", name: "Codex", provider: "codex", hasGuide: false },
  { key: "notion-ai", name: "Notion AI", provider: "notion", hasGuide: false },
];

/** Live grants held by a tool, never the console's own. */
export function toolGrants(grants: readonly GrantFacts[] | undefined): GrantFacts[] {
  return (grants ?? []).filter(
    (grant) => grant.status === "active" && grant.clientId !== CONSOLE_CLIENT_ID,
  );
}

function used(grant: GrantFacts): boolean {
  return typeof grant.lastUsedAt === "number" && grant.lastUsedAt > 0;
}

/** One row per client we name, with the status its grants support. */
export function connectionRows(grants: readonly GrantFacts[] | undefined): ClientRow[] {
  const live = toolGrants(grants);
  return ROWS.map((row) => {
    const mine = live.filter(
      (grant) => providerIdForClientName(grant.clientName ?? grant.clientId) === row.provider,
    );
    const status: ClientStatus = mine.some(used)
      ? "connected"
      : mine.length > 0
        ? "connecting"
        : "not-connected";
    return { key: row.key, name: row.name, status, hasGuide: row.hasGuide };
  });
}

/**
 * Whether any tool has reached this context yet.
 *
 * Any tool, named by us or not: somebody who connected a client this list
 * does not name has still connected one, and telling them we are waiting
 * would be wrong.
 */
export function toolsLive(grants: readonly GrantFacts[] | undefined): boolean {
  return toolGrants(grants).some(used);
}

/** How many events the tail shows. A glimpse, not the log. */
export const LIVE_TAIL = 8;

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The newest reads and writes, named by the agent that made them. */
export function liveEvents(activity: AgentActivityView | undefined): LiveEvent[] {
  if (activity === undefined) return [];
  const names = new Map(activity.agents.map((agent) => [agent.id, agent.name]));
  return [...activity.marks]
    .sort((a, b) => b.at - a.at)
    .slice(0, LIVE_TAIL)
    .map((mark) => ({
      id: `${mark.agent}:${mark.at}:${mark.path}`,
      when: clock(mark.at),
      client: names.get(mark.agent) ?? "A tool",
      action: mark.kind === "write" ? "wrote" : "read",
      target: mark.path,
    }));
}
