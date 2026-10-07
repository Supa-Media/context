/**
 * "For your teams", the orchestrator's trips into a person's teams: which
 * teams they may write for, each team's folders, and Undo on a sent note.
 *
 * A team is a shared workspace where the person is an owner or an editor,
 * read live from membership at every trip: a card names a team by `@name`,
 * and a person who has since left it, or been made read-only, reaches nothing.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { MAX_ROUTE_TEAMS } from "../../../../mcp/src/organizer/routes.js";
import type { Routing } from "./sweepOps";
import { organizerOp } from "./trip";
import type { TeamOutline } from "./whatChanged";

export interface WritableTeam {
  workspaceId: Id<"workspaces">;
  name: string;
  title: string;
}

export async function listWritableTeams(ctx: ActionCtx, personalId: Id<"workspaces">, userId: Id<"users">): Promise<WritableTeam[]> {
  return await ctx.runQuery(internal.functions.organizerRoutes.writableTeams, { workspaceId: personalId, userId });
}

/** The team a card names, if the person may still write there. */
export async function teamNamed(ctx: ActionCtx, personalId: Id<"workspaces">, userId: Id<"users">, name: string) {
  return (await listWritableTeams(ctx, personalId, userId)).find((team) => team.name === name) ?? null;
}

/**
 * The teams a sweep writes for, with their folders: those switched on, at
 * most `MAX_ROUTE_TEAMS`. A team whose folders can't be read is left out of
 * this sweep, not the cause of a failed one. Null when there are none.
 */
export async function teamOutlines(
  ctx: ActionCtx,
  personalId: Id<"workspaces">,
  userId: Id<"users">,
  routing: Routing,
): Promise<{ outlines: TeamOutline[]; keep: string } | null> {
  const teams = (await listWritableTeams(ctx, personalId, userId)).filter((team) => !routing.off.includes(team.name)).slice(0, MAX_ROUTE_TEAMS);
  const outlines: TeamOutline[] = [];
  for (const team of teams) {
    try {
      const outline = (await organizerOp(ctx, team.workspaceId, userId, { action: "outline" }, "editor")) as { folders: TeamOutline["folders"] };
      outlines.push({ name: team.name, title: team.title, folders: outline.folders });
    } catch {
      console.error(JSON.stringify({ event: "organizer_team_outline_failed", workspaceId: personalId }));
    }
  }
  return outlines.length > 0 ? { outlines, keep: routing.keep } : null;
}

/** Undo on a sent note: into that team's trash, if the person still writes there. */
export async function unsendRoute(
  ctx: ActionCtx,
  personalId: Id<"workspaces">,
  userId: Id<"users">,
  token: { team: string; path: string },
): Promise<{ applied: boolean; error?: string }> {
  const team = await teamNamed(ctx, personalId, userId, token.team);
  if (!team) return { applied: false, error: `You can't change notes in ${token.team} any more.` };
  try {
    return (await organizerOp(ctx, team.workspaceId, userId, { action: "withdraw", input: { path: token.path } }, "editor")) as { applied: boolean };
  } catch {
    return { applied: false, error: "That note changed since. It's still there." };
  }
}
