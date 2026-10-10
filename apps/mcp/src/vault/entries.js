/**
 * Vault entries in the bucket: where they live, what a site is, who may use
 * one. The seal itself is `seal.js`.
 *
 * Every function takes the data key as the control plane opens it and the
 * workspace id the caller's grant resolved to. Nothing here decides who the
 * caller is; it is handed `userId` by code that already did.
 */

import { VAULT_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { VaultSealError, openPart, sealPart } from "./seal.js";

export { VAULT_PREFIX };

const ID = /^v[0-9a-f]{24}$/;
const MAX_ENTRIES = 500;
export const MAX_NAME = 80;
export const MAX_SITES = 5;
export const MAX_SECRET = 1024;

export function newEntryId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `v${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isEntryId(value) {
  return typeof value === "string" && ID.test(value);
}

export function entryKey(id) {
  if (!isEntryId(id)) throw new VaultSealError("bad id");
  return `${VAULT_PREFIX}${id}.json`;
}

/**
 * The host a typed site names, lower-cased, or null. "netflix.com",
 * "https://www.netflix.com/login" and "Netflix.com/" all name a host; an
 * address with credentials, a port, an IP or no dot does not.
 */
export function siteHost(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.length === 0 || text.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /^[0-9.]+$/.test(host) || host.startsWith("[")) return null;
  return host;
}

const bare = (host) => (host.startsWith("www.") ? host.slice(4) : host);

/**
 * May an entry saved for `sites` fill a page at `origin`? The page must be
 * https, and its host the saved one or beneath it ("netflix.com" fills
 * "www.netflix.com" and "accounts.netflix.com", never "netflix.com.evil.io").
 */
export function siteMatches(sites, origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const page = bare(url.hostname.toLowerCase());
  return (Array.isArray(sites) ? sites : []).some((site) => {
    const saved = typeof site === "string" ? bare(site) : "";
    return saved.length > 0 && (page === saved || page.endsWith(`.${saved}`));
  });
}

export function mayUse(meta, userId) {
  return typeof userId === "string" && userId.length > 0 && Array.isArray(meta?.people) && meta.people.includes(userId);
}

async function readRecord(store, id) {
  const object = await store.get(entryKey(id));
  if (!object) return null;
  let record;
  try {
    record = JSON.parse(await object.text());
  } catch {
    return null;
  }
  if (record?.format !== "context-vault-entry" || record.id !== id) return null;
  return record;
}

/** One entry's meta, or null when it is missing or does not open. */
export async function readMeta(store, keys, workspaceId, id) {
  if (!isEntryId(id)) return null;
  const record = await readRecord(store, id);
  if (record === null) return null;
  try {
    return await openPart(keys, { workspaceId, entryId: id, part: "meta" }, record.meta);
  } catch {
    return null;
  }
}

/**
 * One entry's secret. Callers: the fill step (`fill.js`) and nothing that
 * returns to a model. Throws rather than answering null, so a caller cannot
 * mistake "did not open" for "empty password".
 */
export async function readSecret(store, keys, workspaceId, id) {
  const record = isEntryId(id) ? await readRecord(store, id) : null;
  if (record === null) throw new VaultSealError("not found");
  return openPart(keys, { workspaceId, entryId: id, part: "secret" }, record.secret);
}

/** Every entry's id and meta that opens here. Never opens a secret. */
export async function listMeta(store, keys, workspaceId) {
  const found = [];
  let cursor;
  do {
    const page = await store.list({ prefix: VAULT_PREFIX, cursor, limit: 1000 });
    for (const object of page?.objects ?? []) {
      const match = /^(v[0-9a-f]{24})\.json$/.exec(object.key.slice(VAULT_PREFIX.length));
      if (match) found.push(match[1]);
      if (found.length >= MAX_ENTRIES) break;
    }
    cursor = page?.truncated && found.length < MAX_ENTRIES ? page.cursor : undefined;
  } while (cursor);
  const metas = await Promise.all(found.map(async (id) => ({ id, meta: await readMeta(store, keys, workspaceId, id) })));
  return metas.filter((entry) => entry.meta !== null);
}

/** Seal and write one entry. Control plane only (`apps/convex/functions/vault.ts`). */
export async function writeEntry(store, keys, workspaceId, { id, meta, secret }) {
  const record = {
    format: "context-vault-entry",
    version: 1,
    id,
    meta: await sealPart(keys, { workspaceId, entryId: id, part: "meta" }, meta),
    secret: await sealPart(keys, { workspaceId, entryId: id, part: "secret" }, secret),
  };
  await store.put(entryKey(id), JSON.stringify(record));
}

/** Rewrite one entry's meta and keep its sealed secret as it is. */
export async function writeMeta(store, keys, workspaceId, id, meta) {
  const record = await readRecord(store, id);
  if (record === null) throw new VaultSealError("not found");
  record.meta = await sealPart(keys, { workspaceId, entryId: id, part: "meta" }, meta);
  await store.put(entryKey(id), JSON.stringify(record));
}

export async function deleteEntry(store, id) {
  await store.delete(entryKey(id));
}
