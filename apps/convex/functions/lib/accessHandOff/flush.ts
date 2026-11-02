/**
 * What a mutation's access writes amount to, decided in its own transaction (`./record.ts` says why).
 *
 * For each object a write changed, by that object's switch (`workspaceObjectHomes.access`):
 *
 * - `convex` (or no record): nothing. Convex decides and the object holds no copy yet.
 * - `dual`: one outbox entry naming the tables that changed, and a push scheduled (`functions/accessObjectPush.ts`),
 *   which sends those tables whole, as Convex holds them when it runs. A write that rolls back takes its entry with it.
 * - `object`: the object decides. A write to a table it is the authority for (members, invites, connections) is
 *   refused with `workspace_switched` unless it is a write behind the object (`writeBehind`), so a Convex writer that
 *   was never moved over cannot quietly become a second answer. The exception is a join or an invitation (`adds.ts`),
 *   which only lets someone in: it is queued as `adds`, and the push puts those rows in the object. A copy table (reach, sharedToMe) is still pushed:
 *   its authority may be a workspace still on `dual`.
 */

import { ConvexError } from "convex/values";
import { foldCovers } from "./fold";
import { addsOf } from "./adds";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { personalWorkspaceOf } from "../faces/people";
import { resolveAddressedUser } from "../identities";
import { accessHomeOf, type AccessScope } from "../accessObjects/home";
import { AUTHORITY_TABLES, targetsOf, type AccessWrite, type ObjectTable } from "./record";

export const WORKSPACE_SWITCHED = "workspace_switched";

/** Which switch decides a table: a workspace's own for members and invites, its person's for the rest. */
export const scopeOf = (table: ObjectTable): AccessScope => (table === "members" || table === "invites" ? "workspace" : "person");

/** The object each person's tables live in: their personal workspace's. `null` for an account without one. */
async function personObject(
  ctx: MutationCtx,
  userId: Id<"users">,
  cache: Map<string, Id<"workspaces"> | null>,
): Promise<Id<"workspaces"> | null> {
  if (!cache.has(userId)) cache.set(userId, (await personalWorkspaceOf(ctx, userId))?._id ?? null);
  return cache.get(userId) ?? null;
}

/** The objects a mutation's writes changed, each with the tables that changed in it. */
export async function objectsChanged(
  ctx: MutationCtx,
  writes: readonly AccessWrite[],
): Promise<Map<Id<"workspaces">, Set<ObjectTable>>> {
  const changed = new Map<Id<"workspaces">, Set<ObjectTable>>();
  const persons = new Map<string, Id<"workspaces"> | null>();
  const add = (workspaceId: Id<"workspaces"> | null, table: ObjectTable) => {
    if (workspaceId === null) return;
    let tables = changed.get(workspaceId);
    if (tables === undefined) changed.set(workspaceId, (tables = new Set()));
    tables.add(table);
  };
  for (const write of writes) {
    for (const target of targetsOf(write)) {
      if (target.kind === "workspace") add(target.workspaceId, target.table);
      else if (target.kind === "person") add(await personObject(ctx, target.userId, persons), target.table);
      else if (target.recipientKind === "name" || target.recipientKind === "email") {
        const userId = await resolveAddressedUser(ctx, { kind: target.recipientKind, value: target.recipient });
        if (userId !== null) add(await personObject(ctx, userId, persons), target.table);
      }
    }
  }
  return changed;
}

/**
 * The outbox entries for `writes`, or a refusal, in the caller's transaction. `writeBehind` is a write made after the
 * object already took the change (the gateway's mirror, the copy); it is never refused and never pushed back.
 */
export async function flushAccessWrites(
  ctx: MutationCtx,
  writes: readonly AccessWrite[],
  options: { writeBehind: boolean | "authorityTaken" },
): Promise<void> {
  if (writes.length === 0 || options.writeBehind === true) return;
  // After a take-away the switched objects already hold the change to their authority tables (`accessTakeAway.ts`).
  const taken = options.writeBehind === "authorityTaken";
  // A fold's own membership rows are written here first and taken to the objects by its queue (`fold.ts`).
  const own: AccessWrite[] = [];
  for (const write of writes) if (!(await foldCovers(ctx, write))) own.push(write);
  const changed = await objectsChanged(ctx, own);
  for (const [workspaceId, tables] of changed) {
    const homes = { workspace: await accessHomeOf(ctx.db, workspaceId, "workspace"), person: await accessHomeOf(ctx.db, workspaceId, "person") };
    const sending: ObjectTable[] = [];
    let adds: ReturnType<typeof addsOf> | undefined;
    for (const table of tables) {
      const home = homes[scopeOf(table)];
      if (home === "convex") continue;
      if (home === "object" && AUTHORITY_TABLES.has(table)) {
        if (taken) continue;
        // Joining and invitations are written here first and put in the object row by row (`adds.ts`).
        if (table === "members" || table === "invites") {
          adds ??= addsOf(own, workspaceId);
          if (adds !== null) continue;
        }
        throw new ConvexError({ code: WORKSPACE_SWITCHED });
      }
      sending.push(table);
    }
    const added = adds !== undefined && adds !== null && (adds.userIds.length > 0 || adds.inviteIds.length > 0) ? adds : undefined;
    if (sending.length === 0 && added === undefined) continue;
    await ctx.db.insert("accessObjectOutbox", { workspaceId, tables: sending.sort(), at: Date.now(), ...(added === undefined ? {} : { adds: added }) });
    await ctx.scheduler.runAfter(0, internal.functions.accessObjectPush.drain, { workspaceId });
  }
}
