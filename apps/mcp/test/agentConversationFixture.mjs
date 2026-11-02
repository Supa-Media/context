/**
 * The texting conversation as a test bucket holds it: the one history record
 * when there is one (read through `withAgentHome`), else the old log's exchanges
 * (`src/agent/events.js`), oldest first, after the old file's turns when it
 * was copied in, else the old file. `bucket` is a Map of key to `{ body }`.
 */
import { EVENTS_PREFIX, idOfKey } from "../src/agent/events.js";

export const OLD_CONVERSATION = ".context/agent/conversations/texts.json";
/** The one history record (`src/agent/history.js`), in the person's object: read through `withAgentHome` (`texStoreFixture.mjs`). */
export const HISTORY_RECORD = ".context/agent/history/texts.json";

export function conversationTurns(bucket) {
  const record = bucket.get(HISTORY_RECORD);
  if (record) return JSON.parse(record.body).turns ?? [];
  const keys = [...bucket.keys()].filter((key) => key.startsWith(EVENTS_PREFIX)).sort().reverse();
  if (keys.length === 0) return JSON.parse(bucket.get(OLD_CONVERSATION)?.body ?? "{}").turns ?? [];
  return keys.flatMap((key) => {
    const entry = JSON.parse(bucket.get(key).body);
    if (entry.legacy) return entry.turns;
    return [
      { role: "user", text: entry.question, ...(entry.thread ? { thread: entry.thread } : {}) },
      { role: "assistant", text: entry.answer, ...(entry.tainted ? { tainted: true } : {}), ...(entry.tools ? { tools: entry.tools } : {}), ...(entry.sources ? { sources: entry.sources } : {}) },
    ];
  });
}

/** The id of the newest exchange kept, or null. */
export function newestExchangeId(bucket) {
  const record = bucket.get(HISTORY_RECORD);
  if (record) return [...(JSON.parse(record.body).turns ?? [])].reverse().find((turn) => turn.role === "user" && typeof turn.id === "string")?.id ?? null;
  const key = [...bucket.keys()].filter((name) => name.startsWith(EVENTS_PREFIX)).sort()[0];
  return key === undefined ? null : idOfKey(key);
}

/** The conversation as one string, for a check that it holds, or never holds, some words. */
export function conversationText(bucket) {
  return JSON.stringify(conversationTurns(bucket));
}
