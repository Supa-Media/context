/**
 * A chat home's own notes, read straight from the chat's Durable Object.
 *
 * A home's voice and about-us notes keep their text in the chat's
 * object (`docs/decisions/texting-assistant/tex-durable-objects.md`). Read as
 * any note is, each one asked the control plane where it lives, read the
 * privacy rules and looked for a shared edit before the object was asked:
 * about 2.5 s of each group reply on 2026-10-31, when Dev2 asked for those
 * steps to be skipped.
 *
 * After each kept exchange (`keepGroupExchange`, behind the reply), the
 * notes' keys are looked up once and kept in the chat's record (`direct`):
 * the voice, the about-us note, and the memory page, the chat's one copy of
 * its history (`groupMemoryCarry.js`). The next turn asks the object for their
 * words by key. Anything that does not match (no key kept, a key that is not
 * this chat's own, a note gone) is read the old way, so a miss costs one object
 * call and changes nothing. Writes always go through the note tools, which
 * keep the page's version and its tree row.
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

/** The kept keys for this chat, or null: `{voice, about, memory}`. */
function keptDirect(group, record) {
  const direct = record?.direct;
  return group?.home?.store && direct && typeof direct === "object" ? direct : null;
}

/**
 * `{etag, body}` of a kept note (`which`: "voice", "about" or "memory"), or null to read it the old way. A voice or
 * about-us note the last lookup found missing (`false`) is an empty one, not a slow read every turn (2026-11-01).
 */
export async function directNote(group, record, which) {
  const key = keptDirect(group, record)?.[which];
  if (key === false && which !== "memory") return { etag: null, body: "" };
  if (!ownKey(group, key)) return null;
  try {
    const object = await group.home.store.get(key);
    return object ? { etag: object.etag, body: await object.text() } : null;
  } catch {
    return null;
  }
}

/**
 * The keys to keep for next turn, after an exchange: one lookup for the paths (`store.keysAt`, `idLayout.js`).
 * `{}` when the home's store cannot say, which leaves every read the old way. A voice or about-us note the lookup
 * did not find is kept as `false`: most homes have neither, and each turn read both the old way, about 1.3 to 3 s of
 * a group reply on 2026-11-01. Every exchange looks again, so a note made since is read from the next turn on. The
 * first `false` is only ever kept after a turn that read the old way, so the voice note's move into the home
 * (`moveVoice`) has run. The memory page is never kept as missing: it is written after this lookup, in the same
 * exchange, and a missing page read as empty would lose the chat's history.
 */
export async function learnDirect(group, { voice, about, memory }, old = null) {
  const store = group?.home?.store;
  if (typeof store?.keysAt !== "function") return {};
  try {
    const paths = { voice, about, memory };
    const before = old ?? {};
    const keys = await store.keysAt([...Object.values(paths), ...Object.values(before)].filter((path) => typeof path === "string"));
    const own = (path) => (ownKey(group, keys?.[path]) ? keys[path] : undefined);
    const missing = (path) => (keys?.[path] === false ? false : undefined);
    const direct = {};
    const stillOld = [];
    for (const [which, path] of Object.entries(paths)) {
      // A note found only under its name before the 2026-11-01 rename lives there until the rename runs (`homeNames.js`).
      const was = before[which];
      const live = keys?.[path] === false && typeof was === "string" && typeof keys?.[was] === "string" ? was : path;
      if (live !== path) stillOld.push(which);
      direct[which] = own(live) ?? (which === "memory" ? undefined : missing(live));
    }
    if (old !== null) direct.old = stillOld;
    return Object.fromEntries(Object.entries(direct).filter(([, value]) => value !== undefined));
  } catch {
    return {};
  }
}
