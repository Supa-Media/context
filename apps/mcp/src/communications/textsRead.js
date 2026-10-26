/**
 * Reading the Messages backup's index (`textsIndex.js`): a search, the list
 * of conversations, and one conversation's texts.
 *
 * Every function takes a D1 client for the caller's own context and nothing
 * else; who may call them is decided before a client exists (`tools/texts.js`).
 * Every value is bound; a person's words never become SQL.
 */

/** Rows one answer returns at most. */
export const TEXTS_MOST = 50;

/**
 * A search as full-text terms: its words and numbers, each quoted, all
 * required. Operators a person did not mean (`NEAR`, `*`, `:`) are dropped
 * with the punctuation. Null when nothing is left to look for.
 */
export function ftsQueryOf(query) {
  const words = String(query ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.slice(0, 12).map((word) => `"${word}"`).join(" ");
}

function likeOf(text) {
  return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const WITH_CHATS = `r.chat IN (
  SELECT c.chat FROM texts_records AS c
  WHERE c.kind = 'chat' AND (
    c.words LIKE ?W ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM json_each(c.body, '$.members') AS m
      WHERE m.value LIKE ?W ESCAPE '\\'
         OR m.value IN (SELECT p.handle FROM texts_records AS p WHERE p.kind = 'person' AND p.words LIKE ?W ESCAPE '\\')
    )
  )
)`;

function filters({ withWho, since, before }, params) {
  const where = [];
  if (withWho) {
    params.W = likeOf(withWho);
    where.push(WITH_CHATS);
  }
  if (Number.isFinite(since)) {
    params.S = since;
    where.push("r.at >= ?S");
  }
  if (Number.isFinite(before)) {
    params.B = before;
    where.push("r.at < ?B");
  }
  return where;
}

/**
 * Named parameters as D1's HTTP API takes them: positional, in order. Each
 * `?X` becomes `?n` for its place in `order`.
 */
function bind(sql, named) {
  const order = Object.keys(named);
  const text = sql.replace(/\?([A-Z])\b/g, (_, name) => `?${order.indexOf(name) + 1}`);
  return [text, order.map((name) => named[name])];
}

const parse = (row) => {
  try {
    return JSON.parse(row.body);
  } catch {
    return null;
  }
};

/** Texts matching words, newest first, optionally only with someone and within dates. */
export async function searchTexts(client, { query = null, withWho = null, since = null, before = null, limit = 20 } = {}) {
  const named = {};
  const match = query === null ? null : ftsQueryOf(query);
  if (query !== null && match === null) return { refused: "query has no words to look for." };
  if (match !== null) named.Q = match;
  const where = filters({ withWho, since, before }, named);
  if (match !== null) where.unshift("r.key IN (SELECT key FROM texts_fts WHERE texts_fts MATCH ?Q)");
  if (where.length === 0) return { refused: "say what to look for, who it was with, or since when." };
  named.L = Math.min(Math.max(1, limit), TEXTS_MOST);
  const [sql, params] = bind(
    `SELECT r.body FROM texts_records AS r WHERE r.kind = 'message' AND ${where.join(" AND ")} ORDER BY r.at DESC LIMIT ?L`,
    named,
  );
  return { messages: (await client.query(sql, params)).map(parse).filter(Boolean) };
}

/** The conversations, most recently active first. */
export async function listTextChats(client, { limit = 30 } = {}) {
  const rows = await client.query(
    `SELECT c.body, (SELECT max(m.at) FROM texts_records AS m WHERE m.kind = 'message' AND m.chat = c.chat) AS last
     FROM texts_records AS c WHERE c.kind = 'chat'
     ORDER BY last IS NULL, last DESC LIMIT ?1`,
    [Math.min(Math.max(1, limit), TEXTS_MOST)],
  );
  return rows.map((row) => ({ chat: parse(row), last: row.last ?? null })).filter((row) => row.chat !== null);
}

/** One conversation's texts in order, the newest `limit` within the dates given. */
export async function readTextChat(client, { chat, since = null, before = null, limit = TEXTS_MOST } = {}) {
  const named = { C: chat };
  const where = ["r.chat = ?C", ...filters({ since, before }, named)];
  named.L = Math.min(Math.max(1, limit), TEXTS_MOST);
  const [sql, params] = bind(
    `SELECT r.body FROM texts_records AS r WHERE r.kind IN ('message', 'reaction') AND ${where.join(" AND ")} ORDER BY r.at DESC LIMIT ?L`,
    named,
  );
  const [chatRow] = await client.query("SELECT body FROM texts_records WHERE key = ?1", [`chat:${chat}`]);
  return { chat: chatRow ? parse(chatRow) : null, records: (await client.query(sql, params)).map(parse).filter(Boolean).reverse() };
}

/** Names for handles, from the person records; a handle without one is absent. */
export async function namesFor(client, handles) {
  const list = [...new Set(handles.filter((handle) => typeof handle === "string" && handle))];
  if (list.length === 0) return new Map();
  const rows = await client.query(
    "SELECT handle, words FROM texts_records WHERE kind = 'person' AND handle IN (SELECT value FROM json_each(?1))",
    [JSON.stringify(list)],
  );
  return new Map(rows.map((row) => [row.handle, row.words]));
}

/** The conversations with these ids, by id. */
export async function chatsFor(client, ids) {
  const list = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (list.length === 0) return new Map();
  const rows = await client.query(
    "SELECT body FROM texts_records WHERE kind = 'chat' AND chat IN (SELECT value FROM json_each(?1))",
    [JSON.stringify(list)],
  );
  return new Map(rows.map(parse).filter(Boolean).map((chat) => [chat.id, chat]));
}
