/**
 * TEX'S SIGN-INS, SEALED IN THE PERSON'S OWN VAULT.
 *
 * Decided by the owner, 2026-10-20 (`docs/decisions/texting-assistant/vault.md`):
 * Tex's Browserbase browser keeps nothing at Browserbase, so each new one
 * started signed out and the person was asked to sign in again. Its cookies,
 * and each site's localStorage and IndexedDB where many apps keep a sign-in
 * (Firebase Auth keeps its in IndexedDB; added 2026-10-22), are now kept
 * here, at `.context/vault/browser-jar.json` in the person's own bucket,
 * sealed the way a vault login is (`vault/seal.js`): the workspace data key,
 * held outside the bucket, with associated data naming this jar, so the bucket
 * alone never yields a sign-in and no vault entry's sealed part opens as one.
 *
 * A personal workspace's only: the browser is one person's (`browserOwner`),
 * so its sign-ins are theirs, never a shared workspace's. The jar goes from
 * here to the screenshot Worker and back (`browserProviders.js`); it is never
 * in a tool result, a log or a message, and a model never sees it.
 */

import { VAULT_PREFIX } from "../vault/entries.js";
import { openPart, sealPart } from "../vault/seal.js";

export const JAR_KEY = `${VAULT_PREFIX}browser-jar.json`;
const FORMAT = "context-browser-jar";
const SEAL = { entryId: "browser-jar", part: "jar" };
/** The most a sealed jar may come to. */
export const MAX_JAR_CHARS = 2 * 1024 * 1024;
const MAX_ORIGINS = 100;

const isJar = (value) => value && typeof value === "object" && Array.isArray(value.cookies) && value.storage && typeof value.storage === "object";

const isEmpty = (value) => !value || (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);

/** Each origin read replaces what was held for it; an empty one is dropped. The origin read last is kept first. */
function mergeOrigins(held, read) {
  const merged = { ...(held ?? {}) };
  for (const [origin, value] of Object.entries(read ?? {})) {
    delete merged[origin];
    if (!isEmpty(value)) merged[origin] = value;
  }
  const origins = Object.keys(merged);
  return Object.fromEntries(origins.slice(Math.max(0, origins.length - MAX_ORIGINS)).map((origin) => [origin, merged[origin]]));
}

/**
 * The jar after a browser was read: its cookies are all the browser's (it was
 * given every saved one when it started), and the one origin it was on has
 * the storage and IndexedDB it showed, an empty one meaning that site signed
 * out. IndexedDB the browser could not read is absent, so the held copy stays.
 */
export function mergeJar(held, read) {
  const storage = mergeOrigins(held?.storage, read.storage);
  const idb = mergeOrigins(held?.idb, read.idb);
  return { cookies: read.cookies, storage, ...(Object.keys(idb).length > 0 ? { idb } : {}) };
}

/** Give up the saved site data read longest ago, IndexedDB first; false when there is none left. */
function dropOldest(jar) {
  for (const kind of ["idb", "storage"]) {
    const origins = Object.keys(jar[kind] ?? {});
    if (origins.length === 0) continue;
    delete jar[kind][origins[0]];
    if (kind === "idb" && origins.length === 1) delete jar.idb;
    return true;
  }
  return false;
}

/** Where this turn's sign-ins are kept, or null when it has nowhere to keep them. */
export function browserJar(store) {
  const keys = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  const personal = (store?.contexts ?? []).find((entry) => entry?.current)?.kind === "personal";
  if (!keys || typeof workspaceId !== "string" || !personal || typeof store.get !== "function" || typeof store.put !== "function") return null;
  const where = { workspaceId, ...SEAL };
  let held;
  let written = null;

  async function load() {
    if (held !== undefined) return held;
    held = null;
    try {
      const object = await store.get(JAR_KEY);
      if (!object) return held;
      const record = JSON.parse(await object.text());
      if (record?.format !== FORMAT) return held;
      const jar = await openPart(keys, where, record.jar);
      if (isJar(jar)) held = jar;
    } catch {
      // A jar that does not open is no jar: Tex signs in again, as before.
    }
    return held;
  }

  return {
    load,
    /** Seal what the browser held, when it changed. A failure keeps the last jar. */
    async save(read) {
      if (!isJar(read)) return;
      const next = mergeJar(await load(), read);
      const plain = JSON.stringify(next);
      if (plain === written || plain === JSON.stringify(held)) return;
      try {
        let record = JSON.stringify({ format: FORMAT, version: 1, jar: await sealPart(keys, where, next) });
        // Too big: the sites read longest ago give up their IndexedDB, then their storage, so a full jar still takes new sign-ins.
        while (record.length > MAX_JAR_CHARS && dropOldest(next)) {
          record = JSON.stringify({ format: FORMAT, version: 1, jar: await sealPart(keys, where, next) });
        }
        if (record.length > MAX_JAR_CHARS) return;
        await store.put(JAR_KEY, record);
        held = next;
        written = plain;
      } catch {
        // Unsaved sign-ins are asked for again next time; nothing else is lost.
      }
    },
  };
}
