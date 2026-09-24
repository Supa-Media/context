import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { useAgentActivity } from "../../console/agents/useAgentActivity";
import { ConnectionsStep, type ClientRow } from "../redesign/ConnectionsStep";
import { ClaudeGuideStep } from "../redesign/ClaudeGuideStep";
import { ChatGPTGuideStep } from "../redesign/ChatGPTGuideStep";
import { ToolsLiveStep } from "../redesign/ToolsLiveStep";
import { connectionRows, liveEvents, toolsLive, type GrantFacts } from "../tools";

/**
 * The two steps about the person's own AI tools, wired to what the control
 * plane and the gateway already report — no backend of their own.
 *
 * Each container subscribes to exactly what its screen draws, for the one
 * context the first run just made, and nothing while it is not on screen. The
 * rules that turn those facts into rows and a "Live" pill are `../tools.ts`.
 */

/** This context's grants, or `undefined` while the subscription answers. */
function useToolGrants(workspaceId: Id<"workspaces"> | null): GrantFacts[] | undefined {
  const grants = useQuery(
    api.functions.grants.listGrants,
    workspaceId === null ? "skip" : { workspaceId },
  );
  if (grants === undefined || grants instanceof Error) return undefined;
  return grants as GrantFacts[];
}

/**
 * A-07, with the Claude and ChatGPT walkthroughs as views inside it rather
 * than steps of their own: a guide is somewhere you go and come back from, and
 * the rail should not grow a step for a detour.
 */
export function ConnectionsContainer({
  workspaceId,
  onContinue,
}: {
  workspaceId: Id<"workspaces"> | null;
  onContinue: () => void;
}) {
  const grants = useToolGrants(workspaceId);
  const [guide, setGuide] = useState<ClientRow["key"] | null>(null);
  const back = () => setGuide(null);

  if (guide === "claude-desktop") return <ClaudeGuideStep onDone={back} onBack={back} />;
  if (guide === "chatgpt") return <ChatGPTGuideStep onDone={back} onBack={back} />;
  return (
    <ConnectionsStep
      clients={connectionRows(grants)}
      onOpenGuide={(key) => setGuide(key)}
      onSkip={onContinue}
    />
  );
}

/**
 * A-11. Live on any tool's first authenticated call (`lastUsedAt`, stamped by
 * the gateway), with the tail of what tools read and wrote from the activity
 * log the console already polls every half minute.
 */
export function ToolsLiveContainer({
  workspaceId,
  onContinue,
}: {
  workspaceId: Id<"workspaces"> | null;
  onContinue: () => void;
}) {
  const grants = useToolGrants(workspaceId);
  const activity = useAgentActivity(workspaceId, MCP_ENDPOINT);
  return (
    <ToolsLiveStep
      state={toolsLive(grants) ? "connected" : "waiting"}
      events={liveEvents(activity)}
      onContinue={onContinue}
    />
  );
}
