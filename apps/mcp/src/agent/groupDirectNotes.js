/**
 * A chat home's own notes, read straight from the chat's Durable Object.
 *
 * A home's memory, voice and about-us notes keep their text in the chat's
 * object (`docs/decisions/texting-assistant/tex-durable-objects.md`). Read as
 * any note is, each one asked the control plane where it lives, read the
 * privacy rules and looked for a shared edit before the object was asked:
 * about 2.5 s of each group reply on 2026-10-31, when Dev2 asked for those
 * steps to be skipped.
 *
 * After each kept exchange (`keepGroupExchange`, behind the reply), the three
 * notes' keys are looked up once and kept in the chat's memory record
 * (`direct`), with the memory note's object version as Tex left it. The next
 * turn asks the object for them by key: the memory note's version alone (the
 * same as Tex left it means nobody edited it, so the record's turns stand), the
 * other two notes' words. Anything that does not match (no key kept, a key that
 * is not this chat's own, a version that moved, a note gone) is read the old
 * way, so a miss costs one object call and changes nothing.
 *
 * Only note keys of this chat's own object (`splitTexKey`, `texRouting.js`): a home is
 * opened by this chat's grant alone, and its notes are its people's, so no
 * privacy rule there can narrow one below the chat.
 */

import { splitTexKey } from "../store/texRouting.js";

/** Whether `key` names a note in this chat's own object. */
function ownKey(group, key) {
  const split = splitTexKey(key);
  return split !== null && typeof group?.key === "string" && split.owner === `chat:${group.key}` && split.key.startsWith("notes/");
}

/** The kept keys for this chat, or null: `{memory: {key, version}, voice, about}`. */
function keptDirect(group, record) {
  const direct = record?.direct;
  return group?.home?.store && direct && typeof direct === "object" ? direct : null;
}

/** True when the memory note is the version Tex left (its words are the record's turns); false to read it the old way. */
export async function memoryUnedited(group, record) {
  const memory = keptDirect(group, record)?.memory;
  if (!ownKey(group, memory?.key) || typeof memory.version !== "string" || typeof record?.noteEtag !== "string") return false;
  try {
    const store = group.home.store;
    const object = typeof store.head === "function" ? await store.head(memory.key) : await store.get(memory.key);
    return object?.etag === memory.version;
  } catch {
    return false;
  }
}

/** `{etag, body}` of a kept note (`which`: "voice" or "about"), or null to read it the old way. */
export async function directNote(group, record, which) {
  const key = keptDirect(group, record)?.[which];
  if (!ownKey(group, key)) return null;
  try {
    const object = await group.home.store.get(key);
    return object ? { etag: object.etag, body: await object.text() } : null;
  } catch {
    return null;
  }
}

/**
 * The keys to keep for next turn, after Tex wrote the memory note: one lookup for the three paths
 * (`store.keysAt`, `idLayout.js`) and the memory note's object version. `{}` when the home's store
 * cannot say, which leaves every read the old way.
 */
export async function learnDirect(group, { memory, voice, about }) {
  const store = group?.home?.store;
  if (typeof store?.keysAt !== "function") return {};
  try {
    const keys = await store.keysAt([memory, voice, about].filter((path) => typeof path === "string"));
    const own = (path) => (ownKey(group, keys?.[path]) ? keys[path] : undefined);
    const direct = { voice: own(voice), about: own(about) };
    const memoryKey = own(memory);
    if (memoryKey !== undefined) {
      const object = typeof store.head === "function" ? await store.head(memoryKey) : await store.get(memoryKey);
      if (typeof object?.etag === "string") direct.memory = { key: memoryKey, version: object.etag };
    }
    return Object.fromEntries(Object.entries(direct).filter(([, value]) => value !== undefined));
  } catch {
    return {};
  }
}
