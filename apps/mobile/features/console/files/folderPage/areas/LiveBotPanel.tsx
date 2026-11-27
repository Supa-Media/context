/**
 * The bot panel with the reader's mail read and saved with its version, so Refresh adds a line to mail already there
 * and stays on the page. Drawn only where the page names its workspace; elsewhere (a fixture, a test) the plain panel.
 */

import { useMailIO } from "../../../mailPage/useMailIO";
import { BotPanel, type BotPanelProps } from "./BotPanel";

export type AnyBotPanelProps = BotPanelProps & { workspaceId?: string };

function Live({ workspaceId, ...props }: BotPanelProps & { workspaceId: string }) {
  const io = useMailIO(workspaceId);
  return <BotPanel {...props} io={io} />;
}

export function AnyBotPanel({ workspaceId, ...props }: AnyBotPanelProps) {
  // Keyed by the bot, so nothing one bot's panel holds (a mail just started, a problem, a tab) shows on another's.
  return workspaceId === undefined || workspaceId === "" ? <BotPanel key={props.bot.slug} {...props} /> : <Live key={props.bot.slug} {...props} workspaceId={workspaceId} />;
}
