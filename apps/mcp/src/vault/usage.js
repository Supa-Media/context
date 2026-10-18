/**
 * What Settings › Vault says about each key's use (vault board 2): how many
 * times each AI used it and the last address it called, which AIs the person
 * said no to, and which are waiting for an answer now.
 *
 * Kept inside the key's own sealed meta, next to the yeses it describes, so a
 * key and its history move, export and are deleted together. Written only on
 * condition of the version just read (`changeMeta`): a use landing at the same
 * moment as Cut off can never write an old list of AIs back. Storage that
 * cannot promise that records no use rather than risk it; the key still works.
 *
 * Only the method and the path are kept, never a query, a header or a body,
 * the same as the audit entry for the use.
 */

import { listAllKeysWithLegacy } from "../notes/storage.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { PENDING_PREFIX } from "../tools/approvalKeys.js";
import { belongsTo } from "./access.js";
import { changeMeta } from "./entries.js";

/** How many AIs one key remembers uses and refusals for. */
export const MAX_TRACKED = 50;
const MAX_PATH = 200;

const clientOf = (actor) => (typeof actor?.clientId === "string" && actor.clientId.length > 0 ? actor.clientId : null);
const nameOf = (name) => (typeof name === "string" && name.length > 0 ? name.slice(0, 120) : null);

/** The path as it is kept: no query or fragment, bounded. */
export function keptPath(path) {
  const text = typeof path === "string" ? path.split(/[?#]/)[0] : "";
  return text.slice(0, MAX_PATH) || "/";
}

/**
 * Count one use of `entryId` by the AI on `store.actor`. Answers whether it
 * was written; a clash or storage without conditional writes answers false.
 */
export async function noteUse(store, entryId, { method, path, now = Date.now() }) {
  const clientId = clientOf(store?.actor);
  const keys = store?.encryptionKey;
  if (clientId === null || !keys || store?.capabilities?.conditionalWrite === false) return false;
  const userId = store.actor.userId;
  const written = await changeMeta(store, keys, store.actor.workspaceId, entryId, (meta) => {
    if (!meta?.proxy) return null;
    const uses = Array.isArray(meta.proxy.uses) ? meta.proxy.uses : [];
    const mine = (use) => use?.id === clientId && belongsTo(use, userId, meta);
    const earlier = uses.find(mine);
    const use = {
      id: clientId,
      ...(typeof userId === "string" && userId.length > 0 ? { by: userId } : {}),
      name: nameOf(store.actor.client) ?? earlier?.name ?? null,
      count: (Number.isFinite(earlier?.count) ? earlier.count : 0) + 1,
      at: now,
      method: typeof method === "string" ? method.toUpperCase().slice(0, 8) : "GET",
      path: keptPath(path),
    };
    const rest = uses.filter((other) => !mine(other));
    return { ...meta, proxy: { ...meta.proxy, uses: [...rest, use].slice(-MAX_TRACKED) } };
  });
  return written.meta != null;
}

/**
 * Remember that the person said No to the AI on an ask (`record` is the
 * settled ask), so Settings can say so and offer Allow.
 */
export async function noteRefusal(store, record, { now = Date.now() } = {}) {
  const clientId = clientOf(record?.actor);
  const entryId = record?.entry_id;
  const keys = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  if (clientId === null || typeof entryId !== "string" || !keys || typeof workspaceId !== "string") return false;
  if (store?.capabilities?.conditionalWrite === false) return false;
  const userId = record?.actor?.userId;
  const written = await changeMeta(store, keys, workspaceId, entryId, (meta) => {
    if (!meta?.proxy) return null;
    const refused = (Array.isArray(meta.proxy.refused) ? meta.proxy.refused : []).filter(
      (no) => !(no?.id === clientId && belongsTo(no, userId, meta)),
    );
    const entry = { id: clientId, name: nameOf(record.actor.client), at: now, ...(typeof userId === "string" ? { by: userId } : {}) };
    return { ...meta, proxy: { ...meta.proxy, refused: [...refused, entry].slice(-MAX_TRACKED) } };
  });
  return written.meta != null;
}

/**
 * The first-use asks waiting for this person now, as entry id → how many AIs
 * are waiting on it. Expired asks count as answered (no answer is a no).
 */
export async function waitingAsks(store, userId, now = Date.now()) {
  const waiting = new Map();
  const seen = new Set();
  const keys = await listAllKeysWithLegacy(store, PENDING_PREFIX);
  for (const { key } of keys) {
    let record;
    try {
      const object = await getWithLegacyFallback(store, key);
      record = object ? JSON.parse(await object.text()) : null;
    } catch {
      continue;
    }
    if (record?.kind !== "vault_use" || typeof record.entry_id !== "string") continue;
    if (record.actor?.userId !== userId || !(record.expires_at > now)) continue;
    const who = `${record.entry_id}\n${record.actor?.clientId ?? ""}`;
    if (seen.has(who)) continue;
    seen.add(who);
    waiting.set(record.entry_id, (waiting.get(record.entry_id) ?? 0) + 1);
  }
  return waiting;
}
