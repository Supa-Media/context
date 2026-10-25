/**
 * The texting conversation as a test bucket holds it: the log's exchanges
 * (`src/agent/events.js`), oldest first, after the old file's turns when it
 * was copied in, else the old file. `bucket` is a Map of key to `{ body }`.
 */
import { EVENTS_PREFIX } from "../src/agent/events.js";

export const OLD_CONVERSATION = ".context/agent/conversations/texts.json";

export function conversationTurns(bucket) {
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

/** The conversation as one string, for a check that it holds, or never holds, some words. */
export function conversationText(bucket) {
  return JSON.stringify(conversationTurns(bucket));
}
