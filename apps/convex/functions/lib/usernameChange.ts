/**
 * Changing a username (decided by the owner, 2026-11-22: "only allow people to change twice in a lifetime, and let
 * them keep their old name"; `docs/decisions/identity-and-access/username-changes.md`).
 *
 * A username is the slug of the person's personal workspace, so a change is a slug change on that workspace. Storage,
 * the workspace object (`workspace:<workspaceId>`), grants and memberships are all keyed by ids and move with nothing.
 * What changes is the name layer:
 *
 *  - **The old name stays theirs.** Its `names` row is kept, still pointing at the workspace, and the name is listed in
 *    `formerSlugs`. Everything that resolves a name through `findName` (websites, short links, capture mail,
 *    invitations and shares by name, `@name` in a grant) keeps reaching the same person by it, and nobody else can
 *    claim it. It is freed only with the workspace, as the current name is.
 *  - **Twice in a lifetime.** `slugChanges` counts every change, a change back to a former name included, and the
 *    third is refused. The count lives on the personal workspace, which lives and dies with the account.
 *  - **Copies of the handle are refreshed.** Saved session lists are forgotten (`forgetGrantResolveCache`), every
 *    member's reach is sent to their object again, and a workspace object that decides its own members is told its new
 *    name through the take-away queue, so the reach rows it writes later carry it.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { accessHomeOf } from "./accessObjects/home";
import { forgetGrantResolveCache } from "./controlPlane/grantCacheRows";
import { personalWorkspaceOf } from "./faces/people";
import { checkAvailability, claimName, findName, nameRejectionError } from "./nameClaims";
import { validateName } from "./names";
import { aliasesOf } from "./workspaces/aliases";

/** How many times a person may change their username, ever. */
export const MAX_USERNAME_CHANGES = 2;

export type UsernameState = {
  username: string;
  formerNames: string[];
  changesLeft: number;
};

/** The person's personal workspace, which they own, or `null` for an account without one. */
async function ownPersonalWorkspace(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"workspaces"> | null> {
  const workspace = await personalWorkspaceOf(ctx, userId);
  return workspace !== null && workspace.kind === "personal" ? workspace : null;
}

export function usernameStateOf(workspace: Doc<"workspaces">): UsernameState {
  return {
    username: workspace.slug,
    formerNames: aliasesOf(workspace),
    changesLeft: Math.max(0, MAX_USERNAME_CHANGES - (workspace.slugChanges ?? 0)),
  };
}

export async function usernameState(ctx: QueryCtx, userId: Id<"users">): Promise<UsernameState | null> {
  const workspace = await ownPersonalWorkspace(ctx, userId);
  return workspace === null ? null : usernameStateOf(workspace);
}

const refused = (code: string, message: string) => new ConvexError({ code, message });

/** Tell every copy of the handle: saved sessions, each member's reach, and the workspace object's own name. */
async function refreshCopies(ctx: MutationCtx, workspaceId: Id<"workspaces">, now: number): Promise<void> {
  await forgetGrantResolveCache(ctx, { workspaceId });
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(500);
  const persons = new Set<Id<"workspaces">>();
  for (const member of members) {
    const personal = await personalWorkspaceOf(ctx, member.userId);
    if (personal !== null) persons.add(personal._id);
  }
  for (const person of persons) {
    if ((await accessHomeOf(ctx.db, person, "person")) === "convex") continue;
    await ctx.db.insert("accessObjectOutbox", { workspaceId: person, tables: ["reach"], at: now });
    await ctx.scheduler.runAfter(0, internal.functions.accessObjectPush.drain, { workspaceId: person });
  }
  // A workspace object that decides its members writes reach rows itself, with the name it was last told: tell it.
  if ((await accessHomeOf(ctx.db, workspaceId, "workspace")) === "object") {
    const id = await ctx.db.insert("accessTakeAways", { kind: "rename", workspaceId, at: now, attempt: 0 });
    await ctx.scheduler.runAfter(0, internal.functions.accessTakeAway.run, { id });
  }
}

/**
 * Change the signed-in person's username to `raw`, or throw. Answers the state after the change.
 *
 * Refusals, each a `ConvexError` with a `code`: `NO_PERSONAL_WORKSPACE`, `USERNAME_UNCHANGED`,
 * `USERNAME_CHANGES_USED` (both changes spent), and `NAME_UNAVAILABLE` with the reason `checkAvailability` gives
 * (malformed, reserved, taken by anyone else). A former name of their own is always available to them.
 */
export async function changeUsername(
  ctx: MutationCtx,
  userId: Id<"users">,
  raw: string,
  actorClientId?: string,
): Promise<UsernameState> {
  const workspace = await ownPersonalWorkspace(ctx, userId);
  if (workspace === null) throw refused("NO_PERSONAL_WORKSPACE", "Only a person with a workspace of their own has a username.");
  const validation = validateName(raw);
  if (!validation.ok) throw nameRejectionError(validation.normalized, validation.reason);
  const wanted = validation.normalized;
  const current = workspace.slug;
  if (wanted === current) throw refused("USERNAME_UNCHANGED", "That is already your username.");
  const changes = workspace.slugChanges ?? 0;
  if (changes >= MAX_USERNAME_CHANGES) {
    throw refused("USERNAME_CHANGES_USED", `A username can be changed ${MAX_USERNAME_CHANGES} times, and yours has been.`);
  }

  // One of their own former names comes back without a new claim: its row still points here.
  const held = await findName(ctx, wanted);
  const ownFormer = held !== null && held.kind === "workspace" && held.workspaceId === workspace._id;
  if (!ownFormer) {
    const availability = await checkAvailability(ctx, wanted);
    if (!availability.available) throw nameRejectionError(availability.normalized, availability.reason);
    await claimName(ctx, wanted, userId, { kind: "workspace", workspaceId: workspace._id });
  }

  // The current name's row stays, so it keeps resolving here and nobody else can take it.
  const oldRow = await findName(ctx, current);
  if (oldRow === null || oldRow.workspaceId !== workspace._id) {
    // A workspace whose own name row is missing is a control-plane bug; refusing keeps the namespace from forking.
    throw refused("USERNAME_ROW_MISSING", "Your current username could not be found. Nothing was changed.");
  }

  const formerSlugs = [...(workspace.formerSlugs ?? []).filter((name) => name !== wanted && name !== current), current];
  const now = Date.now();
  await ctx.db.patch(workspace._id, { slug: wanted, formerSlugs, slugChanges: changes + 1 });
  await refreshCopies(ctx, workspace._id, now);
  await recordAudit(ctx, {
    workspaceId: workspace._id,
    actorUserId: userId,
    ...(actorClientId === undefined ? {} : { actorClientId }),
    action: "username.changed",
    details: { from: current, to: wanted, change: changes + 1 },
  });
  return usernameStateOf({ ...workspace, slug: wanted, formerSlugs, slugChanges: changes + 1 });
}
