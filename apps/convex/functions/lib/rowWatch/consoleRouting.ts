/**
 * The store options that send a console store's note texts to the workspace's object, where its notes live there
 * (`apps/mcp/src/store/workspaceRouting.js`), as the gateway's own stores do. Every store this deployment builds over
 * a workspace's notes takes them (`__tests__/consoleRouting.test.ts` holds every builder to it), so nothing written
 * here lands in the bucket alone once a workspace's home is its object.
 *
 * A bucket workspace gets nothing back, and its store is the bucket's as before.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { R2Store } from "../../../../mcp/src/store/r2.js";
import { texBucket } from "../../../../mcp/src/texStore/wire.js";
import { doorStub } from "./objectDoor";

type Home = "bucket" | "dual" | "object";

export type ConsoleWorkspaceRouting = {
  /** The binding with its home on it, as the factory reads it (`notesHome`). */
  credential: <C extends object>(credential: C) => C & { notesHome?: Home };
  /** The factory's `workspaceStore` option, or absent for a bucket workspace. */
  options: { workspaceStore?: (workspaceId: string) => { bodies: unknown } | null };
};

/** Where this workspace's note texts live now, and the store options that follow it. */
export async function consoleWorkspaceRouting(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: Parameters<typeof doorStub>[2] = {},
): Promise<ConsoleWorkspaceRouting> {
  const home = (await ctx.runQuery(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })) as Home;
  if (home === "bucket") return { credential: (credential) => credential, options: {} };
  const stub = doorStub(ctx, workspaceId, options);
  // A workspace whose notes live in its object, built where the gateway cannot be reached, must not write the
  // bucket alone: refused rather than built.
  if (stub === null) throw new Error("this workspace's notes live in its object, and this deployment cannot reach it");
  const bodies = new R2Store(texBucket(stub));
  return {
    credential: (credential) => ({ ...credential, notesHome: home }),
    options: { workspaceStore: (id: string) => (id === workspaceId ? { bodies } : null) },
  };
}
