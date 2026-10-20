/**
 * TEX'S SIGN-INS, SEALED IN THE PERSON'S OWN VAULT.
 *
 * Decided by the owner, 2026-10-20 (`docs/decisions/texting-assistant/vault.md`):
 * Tex's Browserbase browser keeps nothing at Browserbase, so each new one
 * started signed out and the person was asked to sign in again. Its cookies,
 * and each site's localStorage where many apps keep a sign-in, are now kept
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

/**
 * The jar after a browser was read: its cookies are all the browser's (it was
 * given every saved one when it started), and the one origin it was on has
 * the storage it showed, an empty one meaning that site signed out.
 */
export function mergeJar(held, read) {
  const storage = { ...(held?.storage ?? {}) };
  for (const [origin, items] of Object.entries(read.storage ?? {})) {
    delete storage[origin];
    if (items && Object.keys(items).length > 0) storage[origin] = items;
  }
  // The origin read last is kept first when there are too many.
  const origins = Object.keys(storage);
  const kept = Object.fromEntries(origins.slice(Math.max(0, origins.length - MAX_ORIGINS)).map((origin) => [origin, storage[origin]]));
  return { cookies: read.cookies, storage: kept };
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
        // Too big: the sites read longest ago give up their storage first, so a full jar still takes new sign-ins.
        while (record.length > MAX_JAR_CHARS && Object.keys(next.storage).length > 0) {
          delete next.storage[Object.keys(next.storage)[0]];
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
