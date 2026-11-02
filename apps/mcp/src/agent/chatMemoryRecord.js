/**
 * Where a group chat's memory record lives: the JSON with every kept turn,
 * the chat's one copy of its history (the owner, 2026-11-01;
 * `groupMemoryCarry.js`).
 *
 * When the turn's grant names its chat (`texChatId`, so the session's store
 * was built for that chat: `store/texRouting.js`), the record is the chat's
 * own, in the chat's Durable Object at tex/chat:<chatKey>/state/<sha>.json,
 * one per chat (the owner, 2026-10-31: somebody added to a chat shares what
 * it remembers), never in the bound workspace's bucket. It is the history
 * itself, not a cache of a note, and goes with the object
 * (`docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * - Read: the object's copy. With none, the bucket's old copy for this chat
 *   (`.context/agent/groups/<sha>.json`, named by the chat's key alone) is
 *   moved in once; a copy named by the people in it before that is not
 *   (the visible note carries those words, `chatNoteMove.js`):
 *   written to the object only where nothing is yet, read back, and deleted
 *   from the bucket only when the read-back is the same bytes.
 * - Write: the object alone.
 * - Object unreachable: nothing is kept for the turn, and nothing goes to the
 *   bucket instead. A structured line says so, with no key and no words.
 * - A store built for no chat (a person's own texts, a test store, a grant
 *   minted before chats were named) keeps the bucket record, as before.
 */

import { TexStoreUnavailable, texStateKeyFor } from "../store/texRouting.js";

/** `sha256("memory")`: the record's one name in its chat's object. */
export const CHAT_MEMORY_NAME = "c064fbca9d9de8dd9bb0624984403b28d0da807a69365d4f7fb09123ecb0c405";

/** A record that is not kept this turn: the chat's object cannot be reached, or the grant names another chat. */
class NotKept extends Error {}

/** A strict read that could not reach the record: not the same as a chat with none. */
export class RecordUnreadable extends Error {}

/**
 * Where this turn's record is: `{key, legacy}` in the chat's object, or `{key: legacy}` in the bucket when the store
 * was built for no chat. Throws `NotKept` when the store was built for a chat other than the one the turn names.
 */
function placeOf(store, group, legacy) {
  const chats = Array.isArray(store?.texChats) ? store.texChats : [];
  if (chats.length === 0) return { key: legacy, legacy: null };
  if (!chats.includes(group?.key)) throw new NotKept("another chat");
  return { key: texStateKeyFor(group.key, CHAT_MEMORY_NAME), legacy };
}

function logNotKept(error, step, log) {
  const reason = error instanceof TexStoreUnavailable ? "tex_store_unavailable" : "not_this_chat";
  log(JSON.stringify({ event: "group_memory_not_kept", step, reason }));
}

const isNotKept = (error) => error instanceof NotKept || error instanceof TexStoreUnavailable;

/**
 * The record's text, or null. `legacy` is the bucket key this chat and these people kept it at. A read that cannot
 * reach the object answers null (an empty memory), or with `strict` throws `RecordUnreadable`, so a caller can tell
 * no record from one it could not read; any other failure is thrown, as a bucket read's always was.
 */
export async function readChatMemoryRecord(store, group, legacy, { log = console.log, strict = false } = {}) {
  try {
    const place = placeOf(store, group, legacy);
    const held = await store.get(place.key);
    if (held) return await held.text();
    if (place.legacy === null) return null;
    return await moveIn(store, place.key, place.legacy, log);
  } catch (error) {
    if (!isNotKept(error)) throw error;
    logNotKept(error, "read", log);
    if (strict) throw new RecordUnreadable();
    return null;
  }
}

/** The bucket's old copy, moved into the object: deleted only once the object's read-back is the same bytes. */
async function moveIn(store, key, legacy, log) {
  const old = await store.get(legacy);
  if (!old) return null;
  const bytes = await old.text();
  // Only where nothing is yet: a turn that kept the record meanwhile is never overwritten with the older copy.
  await store.put(key, bytes, { onlyIf: { absent: true } });
  const back = await store.get(key);
  const read = back ? await back.text() : null;
  if (read !== bytes) {
    log(JSON.stringify({ event: "group_memory_move_unverified" }));
    return read ?? bytes;
  }
  await store.delete(legacy);
  return read;
}

/** Keep the record: in the chat's object when the store was built for it, the bucket otherwise; nothing when unreachable. */
export async function writeChatMemoryRecord(store, group, legacy, text, { log = console.log } = {}) {
  try {
    const place = placeOf(store, group, legacy);
    await store.put(place.key, text);
    return true;
  } catch (error) {
    if (!isNotKept(error)) throw error;
    logNotKept(error, "write", log);
    return false;
  }
}
