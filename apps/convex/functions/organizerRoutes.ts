/**
 * "For your teams": notes for a person's teams, written from what arrived in
 * their own inbox, waiting on their What changed page until they press Add.
 *
 * The engine is `mcp/src/organizer/routes.js`; what happens inside a bucket is
 * `lib/organizer/routeOps.ts`. Where everything lives, for a reviewer:
 *
 *  - The cards and the owner's rule are in the owner's own bucket
 *    (`.context/organizer/state.json`), never in this database.
 *  - The arrival (a meeting, an email) never leaves that bucket. Pressing Add
 *    writes a NEW note into the team's bucket at the owner's own clearance
 *    there, which must still be owner or editor, read live.
 *  - The note sent is exactly the text the owner last saw, edits included.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalQuery } from "../_generated/server";
import { MAX_ROUTE_BODY, MAX_ROUTE_TITLE } from "../../mcp/src/organizer/routes.js";
import { listWritableTeams, teamNamed } from "./lib/organizer/routeTrips";
import type { OrganizerSuggestion, OrganizerUndo, Routing } from "./lib/organizer/sweepOps";
import { organizerOp, ownerOf } from "./lib/organizer/trip";

const reasonValidator = v.union(v.literal("people"), v.literal("personal"), v.literal("meeting"), v.literal("owner"));
const routeValidator = v.object({
  id: v.string(),
  team: v.string(),
  teamTitle: v.string(),
  folder: v.string(),
  folderTitle: v.string(),
  title: v.string(),
  body: v.string(),
  leftOut: v.array(v.object({ what: v.string(), why: reasonValidator })),
  source: v.object({ path: v.string(), title: v.string(), kind: v.string() }),
  at: v.number(),
});

/**
 * The shared workspaces this person writes in, as a personal workspace's
 * teams. Only for the owner of a personal workspace: a shared workspace has
 * no inbox of one person's own to send from.
 */
export const writableTeams = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.array(v.object({ workspaceId: v.id("workspaces"), name: v.string(), title: v.string() })),
  handler: async (ctx, args) => {
    const personal = await ctx.db.get(args.workspaceId);
    if (!personal || personal.kind !== "personal") return [];
    const own = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
      .unique();
    if (own?.role !== "owner") return [];
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(200);
    const teams = [];
    for (const membership of memberships) {
      if (membership.role !== "owner" && membership.role !== "editor") continue;
      const workspace = await ctx.db.get(membership.workspaceId);
      if (!workspace || workspace.kind !== "shared") continue;
      teams.push({ workspaceId: workspace._id, name: `@${workspace.slug}`, title: workspace.displayName });
    }
    return teams.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** The cards waiting, newest first, with the teams and the owner's rule. */
export const routes = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    routes: v.array(routeValidator),
    teams: v.array(v.object({ name: v.string(), title: v.string(), on: v.boolean() })),
    keep: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await ownerOf(ctx, args.workspaceId);
    const teams = await listWritableTeams(ctx, args.workspaceId, userId);
    if (teams.length === 0) return { routes: [], teams: [], keep: "" };
    const read = (await organizerOp(ctx, args.workspaceId, userId, { action: "read" })) as { suggestions: OrganizerSuggestion[]; routing: Routing };
    const titles = new Map(teams.map((team) => [team.name, team.title]));
    const cards = read.suggestions
      .filter((item) => item.kind === "route" && item.route && item.source && titles.has(item.route.team))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .map((item) => ({
        id: item.id,
        team: item.route!.team,
        teamTitle: titles.get(item.route!.team)!,
        folder: item.route!.folder,
        folderTitle: item.route!.folderTitle,
        title: item.title,
        body: item.route!.body,
        leftOut: item.route!.leftOut,
        source: { path: item.source!.path, title: item.source!.title, kind: item.source!.kind },
        at: item.at ?? 0,
      }));
    return {
      routes: cards,
      teams: teams.map((team) => ({ name: team.name, title: team.title, on: !read.routing.off.includes(team.name) })),
      keep: read.routing.keep,
    };
  },
});

/** Add: write the note into the team, then take the card off the list. */
export const sendRoute = action({
  args: {
    workspaceId: v.id("workspaces"),
    id: v.string(),
    /** The note as the owner last saw it on the preview, edits included. */
    title: v.string(),
    body: v.string(),
  },
  returns: v.object({
    applied: v.boolean(),
    undo: v.union(v.object({ kind: v.literal("sent"), team: v.string(), path: v.string() }), v.null()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await ownerOf(ctx, args.workspaceId);
    if (args.title.length > MAX_ROUTE_TITLE * 2 || args.body.length > MAX_ROUTE_BODY) {
      throw new ConvexError({ code: "CONTENT_TOO_LARGE", message: "That note is too long for a team note." });
    }
    const read = (await organizerOp(ctx, args.workspaceId, userId, { action: "read" })) as { suggestions: OrganizerSuggestion[] };
    const card = read.suggestions.find((item) => item.id === args.id && item.kind === "route");
    if (!card?.route) return { applied: false, undo: null, error: "That note is no longer waiting." };
    const team = await teamNamed(ctx, args.workspaceId, userId, card.route.team);
    if (!team) return { applied: false, undo: null, error: `You can't add notes to ${card.route.team} any more.` };
    let path: string;
    try {
      ({ path } = (await organizerOp(
        ctx,
        team.workspaceId,
        userId,
        { action: "deliver", input: { folder: card.route.folder, title: args.title, body: args.body, kind: card.source?.kind ?? "note" } },
        "editor",
      )) as { path: string });
    } catch (thrown) {
      const message = thrown instanceof ConvexError ? String((thrown.data as { message?: unknown })?.message ?? "") : "";
      return { applied: false, undo: null, error: message || `That note couldn't be added to ${team.name}.` };
    }
    const outcome = (await organizerOp(ctx, args.workspaceId, userId, {
      action: "resolve",
      input: { id: args.id, decision: "accept", sent: { team: team.name, path } },
    })) as { pending: number; changes: number; undo: OrganizerUndo | null };
    await ctx.runMutation(internal.functions.organizer.noteResolved, {
      workspaceId: args.workspaceId,
      userId,
      pending: outcome.pending,
      changes: outcome.changes,
      decision: "accept",
      applied: true,
    });
    return { applied: true, undo: { kind: "sent" as const, team: team.name, path } };
  },
});

/** A team's switch, or the owner's own rule. */
export const setRouting = action({
  args: { workspaceId: v.id("workspaces"), team: v.optional(v.string()), on: v.optional(v.boolean()), keep: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await ownerOf(ctx, args.workspaceId);
    if (args.keep !== undefined && args.keep.length > 2000) throw new ConvexError({ code: "CONTENT_TOO_LARGE", message: "Keep it to a sentence or two." });
    await organizerOp(ctx, args.workspaceId, userId, {
      action: "routing",
      input: {
        ...(args.team !== undefined && args.on !== undefined ? { team: args.team, on: args.on } : {}),
        ...(args.keep !== undefined ? { keep: args.keep } : {}),
      },
    });
    return null;
  },
});
