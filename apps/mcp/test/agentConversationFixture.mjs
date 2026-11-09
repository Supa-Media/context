/**
 * The texting conversation as a test bucket holds it: the person's chat rebuilt
 * from their ledger when the bucket is one `withAgentHome` made and it has
 * entries, else the old history record when there is one (read through `withAgentHome`), else the old log's exchanges
 * (`src/agent/events.js`), oldest first, after the old file's turns when it
 * was copied in, else the old file. `bucket` is a Map of key to `{ body }`.
 */
import { EVENTS_PREFIX, idOfKey } from "../src/agent/events.js";
import { HISTORY } from "../src/agent/conversation.js";
import { conversationFromLedger, exchangeEntries } from "../src/agent/ledgerConversation.js";
import { BACKFILLED } from "../src/agent/ledgerBackfill.js";

/** The person's chat rebuilt from their ledger as every reader now reads it (`ledgerConversation.js`), or null with none. */
function ledgerTurns(bucket) {
  const entries = typeof bucket?.ledgerEntries === "function" ? bucket.ledgerEntries() : [];
  // As the gateway: the ledger is the chat, marked or not (`readLedgerConversation`); a bucket with no ledger falls back below.
  return entries.length > 0 ? HISTORY.keep(conversationFromLedger(entries)) : null;
}

export const OLD_CONVERSATION = ".context/agent/conversations/texts.json";
/** The one history record (`src/agent/history.js`), in the person's object: read through `withAgentHome` (`texStoreFixture.mjs`). */
export const HISTORY_RECORD = ".context/agent/history/texts.json";

export function conversationTurns(bucket) {
  const rebuilt = ledgerTurns(bucket);
  if (rebuilt !== null) return rebuilt;
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
  const rebuilt = ledgerTurns(bucket);
  if (rebuilt !== null) return [...rebuilt].reverse().find((turn) => turn.role === "user" && typeof turn.id === "string")?.id ?? null;
  const record = bucket.get(HISTORY_RECORD);
  if (record) return [...(JSON.parse(record.body).turns ?? [])].reverse().find((turn) => turn.role === "user" && typeof turn.id === "string")?.id ?? null;
  const key = [...bucket.keys()].filter((name) => name.startsWith(EVENTS_PREFIX)).sort()[0];
  return key === undefined ? null : idOfKey(key);
}

/** The conversation as one string, for a check that it holds, or never holds, some words. */
export function conversationText(bucket) {
  return JSON.stringify(conversationTurns(bucket));
}

/**
 * Start the person's chat as these turns (`{role, text, tainted?, at?}`, a
 * question then its answer), written to their ledger as the gateway writes a
 * turn's: their text, Tex's, and the reply entry that vouches for it, clean
 * unless the answer is marked tainted. Replaces what the ledger held. `bucket`
 * is a `withAgentHome` view.
 */
export function seedChat(bucket, turns) {
  const entries = [];
  let at = Date.now() - 60 * 60_000 - turns.length * 1_000;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].role !== "user") continue;
    const answer = turns[i + 1]?.role === "assistant" ? turns[i + 1] : null;
    const turn = `seed${String(i).padStart(6, "0")}`;
    const asked = turns[i].at ?? (at += 1_000);
    entries.push(...exchangeEntries(turns[i].text, answer?.text ?? "", { turn, asked, now: asked + 1 }));
    if (answer) entries.push({ v: 1, id: `${turn}r`, at: asked + 2, kind: "reply", turn, clean: answer.tainted !== true });
  }
  // Its chat from before the ledger is all in (`ledgerBackfill.js`), so every reader reads the ledger.
  bucket.seedLedger([{ v: 1, id: BACKFILLED, at: 1, kind: "note", text: "(The chat before this ledger began was copied in here.)", backfill: "mark" }, ...entries]);
}
