/**
 * The bot panel with the reader's mail read and saved with its version, so Refresh adds a line to mail already there
 * and stays on the page. Drawn only where the page names its workspace; elsewhere (a fixture, a test) the plain panel.
 */

import { useMailIO } from "../../../mailPage/useMailIO";
import { BotPanel, type BotPanelProps } from "./BotPanel";
import { BotLookupsScope, type BotLookups } from "./botHealth";

export type AnyBotPanelProps = BotPanelProps & { workspaceId?: string; lookups?: BotLookups };

function Live({ workspaceId, ...props }: BotPanelProps & { workspaceId: string }) {
  const io = useMailIO(workspaceId);
  return <BotPanel {...props} io={io} workspaceId={workspaceId} />;
}

export function AnyBotPanel({ workspaceId, lookups, ...props }: AnyBotPanelProps) {
  // Keyed by the bot, so nothing one bot's panel holds (a mail just started, a problem, a tab) shows on another's. The
  // page's lookups go with it, since the side panel is drawn outside the page (`botHealth.tsx`).
  return (
    <BotLookupsScope lookups={lookups}>
      {workspaceId === undefined || workspaceId === "" ? <BotPanel key={props.bot.slug} {...props} /> : <Live key={props.bot.slug} {...props} workspaceId={workspaceId} />}
    </BotLookupsScope>
  );
}
