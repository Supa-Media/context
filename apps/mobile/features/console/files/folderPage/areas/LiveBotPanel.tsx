/**
 * The bot panel with what only the account server knows: the reader's mail read and saved with its version (so
 * Refresh adds a line to mail already there and stays on the page) and whether the bot answers its setup check
 * (`apps/convex/functions/botLogins.ts`). Drawn only where the page names its workspace; elsewhere (a fixture, a test)
 * the plain panel.
 */

import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";
import { useMailIO } from "../../../mailPage/useMailIO";
import { BotPanel, type BotPanelProps } from "./BotPanel";

export type AnyBotPanelProps = BotPanelProps & { workspaceId?: string };

function Live({ workspaceId, ...props }: BotPanelProps & { workspaceId: string }) {
  const io = useMailIO(workspaceId);
  const rows = useQuery(api.functions.botHooks.botHookList, { workspaceId: workspaceId as Id<"workspaces"> });
  const health = rows?.find((row) => row.bot === mailJoinName(props.bot.name))?.health ?? null;
  return <BotPanel {...props} io={io} health={health} />;
}

export function AnyBotPanel({ workspaceId, ...props }: AnyBotPanelProps) {
  return workspaceId === undefined || workspaceId === "" ? <BotPanel {...props} /> : <Live {...props} workspaceId={workspaceId} />;
}
