/**
 * The production seams of the id copy's two chains (`copyPass.ts`,
 * `checkPass.ts`): the mover when one is configured, and the bucket through its
 * own credential here otherwise. Kept out of `functions/noteIdsCopy.ts`, which
 * only the two actions that run a chain reach, so no other function of that
 * module is read as reaching a credential.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { runIdCheckPage, runIdCopyPage } from "../../../../mcp/src/moves/idCopyPage.js";
import { runCleanupDeletePage, runCleanupListPage } from "../../../../mcp/src/moves/cleanupPage.js";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import type { GatewayCredential } from "../storage/shapes";
import { storageMoverOrigin } from "../storageMover";
import type { CleanupDeps } from "../cleanup/pass";
import type { CheckDeps } from "./checkPass";
import type { CopyDeps } from "./copyPass";

async function credentialOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<GatewayCredential | null> {
  return (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
}

/** The subset of the bare adapter a HEAD needs: `head` where it exists, else a read for the metadata. */
interface HeadStore {
  head?(key: string): Promise<{ etag: string; size?: number } | null | undefined>;
  get(key: string): Promise<{ etag?: string; size?: number } | null | undefined>;
}

/**
 * The HEAD of each key, through the bare adapter the id copy uses (sealed bytes
 * as they are, `idCopyPage.js`). Metadata only: no body is read where `head`
 * exists. Runs here even when a mover is set, since a key's etag is all it asks.
 */
async function keyHeadsHere(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  keys: string[],
): Promise<({ etag: string; size?: number } | null)[]> {
  const credential = await credentialOf(ctx, workspaceId);
  if (credential === null) throw new Error("SOURCE_UNAVAILABLE");
  const store = storeForBinding({ ...credential, workspaceId: String(workspaceId) }, undefined, { sealedObjects: true }) as unknown as HeadStore;
  return await Promise.all(keys.map((key) => headOf(store, key)));
}

async function headOf(store: HeadStore, key: string): Promise<{ etag: string; size?: number } | null> {
  const head = typeof store.head === "function" ? await store.head(key) : undefined;
  if (head === null) return null;
  if (head !== undefined) return head;
  const object = await store.get(key);
  if (object === null || object === undefined) return null;
  // A key that exists but names no version is not "missing": fail the page rather than report it so.
  if (typeof object.etag !== "string") throw new Error("HEAD_UNREADABLE");
  return { etag: object.etag, ...(typeof object.size === "number" ? { size: object.size } : {}) };
}

export function productionDeps(): { copy: CopyDeps; check: CheckDeps; cleanup: CleanupDeps } {
  const origin = storageMoverOrigin();
  return {
    copy: { origin, credential: credentialOf, copyHere: (page) => runIdCopyPage(page) },
    check: { origin, credential: credentialOf, checkHere: (page) => runIdCheckPage(page), keyHeads: keyHeadsHere },
    // The old-copy cleanup (`lib/cleanup/pass.ts`): the same two places a page can run, as the copy and the check have.
    cleanup: {
      origin,
      credential: credentialOf,
      listHere: (page) => runCleanupListPage(page),
      deleteHere: (page) => runCleanupDeletePage(page),
    },
  };
}
