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
  /**
   * The binding with its workspace and home on it, as the factory reads them (`workspaceId`, `notesHome`,
   * `notesBackfilledAt`). The console's credential names no workspace of its own, and the factory routes nothing for
   * a binding without one: until 2026-11-02 every note the app made or saved in an object-home workspace went to the
   * bucket alone, where the gateway never reads it, so a new note opened read-only in the app.
   */
  credential: <C extends object>(credential: C) => C & { workspaceId?: string; notesHome?: Home; notesBackfilledAt?: number };
  /** The factory's `workspaceStore` option, or absent for a bucket workspace. */
  options: { workspaceStore?: (workspaceId: string) => { bodies: unknown } | null };
};

/** Where this workspace's note texts live now, and the store options that follow it. */
export async function consoleWorkspaceRouting(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: Parameters<typeof doorStub>[2] = {},
): Promise<ConsoleWorkspaceRouting> {
  const { home, backfilledAt } = (await ctx.runQuery(internal.functions.workspaceObjectsRows.notesOf, { workspaceId })) as {
    home: Home;
    backfilledAt: number | null;
  };
  if (home === "bucket") return { credential: (credential) => credential, options: {} };
  const stub = doorStub(ctx, workspaceId, options);
  // A workspace whose notes live in its object, built where the gateway cannot be reached, must not write the
  // bucket alone: refused rather than built.
  if (stub === null) throw new Error("this workspace's notes live in its object, and this deployment cannot reach it");
  const bodies = new R2Store(texBucket(stub));
  return {
    credential: (credential) => ({
      ...credential,
      workspaceId,
      notesHome: home,
      // Read as the gateway reads: once the object holds everything, a key it lacks is not fetched from the bucket.
      ...(backfilledAt === null ? {} : { notesBackfilledAt: backfilledAt }),
    }),
    options: { workspaceStore: (id: string) => (id === workspaceId ? { bodies } : null) },
  };
}
