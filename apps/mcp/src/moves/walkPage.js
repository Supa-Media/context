/**
 * One page of the managed-storage encryption walk: seal, check, unseal or
 * confirm the objects one listing returns, in place.
 *
 * Shared by the two places a page can run: the gateway's mover
 * (`moves/mover.js`), where the bytes never leave Cloudflare, and the control
 * plane's own action (`apps/convex/functions/lib/managedEncryptionFns/walk.ts`),
 * kept as the fallback while the mover is switched off. The control plane
 * keeps the row, the phases and the census (`count` only lists, so it stays
 * there); this is what one page does to its objects.
 *
 * The per-object steps are `store/managedEncryptionWalk.js`'s: conditional
 * writes on the etag read, then a read-back that must open to the same bytes.
 */

import { storeForBinding } from "../store/factory.js";
import { ManagedCipher } from "../store/managedEncryption.js";
import { checkObject, checkPlainObject, sealObject, unsealObject } from "../store/managedEncryptionWalk.js";
import { settleInPool } from "./pool.js";

export const WALK_PAGE_PHASES = Object.freeze(["seal", "check", "unseal", "confirm"]);

/**
 * @param {{
 *   workspaceId: string,
 *   phase: "seal"|"check"|"unseal"|"confirm",
 *   cursor?: string,
 *   source: object,
 *   dataKey: { current: string, keys: Record<string, string> },
 *   limits: { pageSize: number, lanes: number, byteBudget: number },
 * }} page
 * @param {{ buildStore?: typeof storeForBinding }} [deps] seam for tests
 * @returns {Promise<{ phase: string, nextCursor: string | null, done: number }>}
 */
export async function runWalkPage(page, { buildStore = storeForBinding } = {}) {
  // The bare adapter: the walk must see which bytes are still plain.
  const bare = buildStore(page.source, undefined, { sealedObjects: true });
  const cipher = new ManagedCipher(page.workspaceId, page.dataKey);
  const listed = await bare.list({ cursor: page.cursor, limit: page.limits.pageSize });
  /** @type {{ key: string, size?: number }[]} */
  const objects = Array.isArray(listed?.objects) ? listed.objects : [];
  let done = 0;
  const each = (work) =>
    settleInPool(
      objects,
      { lanes: page.limits.lanes, byteBudget: page.limits.byteBudget, sizeOf: (object) => object.size ?? 0 },
      (object) => work(object.key),
    );
  if (page.phase === "seal") {
    await each(async (key) => {
      await sealObject(bare, cipher, key);
      done += 1;
    });
  } else if (page.phase === "check") {
    await each(async (key) => {
      if ((await checkObject(bare, cipher, key)) === "plain") await sealObject(bare, cipher, key);
    });
  } else if (page.phase === "unseal") {
    await each(async (key) => {
      await unsealObject(bare, cipher, key);
      done += 1;
    });
  } else if (page.phase === "confirm") {
    // An object sealed after the unseal pass passed it (a request built
    // before the switch) is opened here rather than left behind.
    await each(async (key) => {
      if ((await checkPlainObject(bare, key)) === "sealed") await unsealObject(bare, cipher, key);
    });
  } else {
    throw new Error("WALK_FAILED");
  }
  const nextCursor = listed?.truncated === true && typeof listed.cursor === "string" && listed.cursor !== ""
    ? listed.cursor
    : null;
  return { phase: page.phase, nextCursor, done };
}
