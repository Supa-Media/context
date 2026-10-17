/**
 * A snippet for a note found only by meaning, out of the search database
 * rather than the note.
 *
 * Search by meaning answers paths and passage numbers and never any of the
 * note's text (`meaning/project.js`), so a note the words missed used to be
 * read out of the bucket for the few lines shown beside it: up to six reads
 * per workspace per search, each a tree lookup, a HEAD and a GET on a keyed
 * workspace. The database already holds every note's body in chunks, the
 * same words the read would have found, so one statement answers all of
 * them (decided by the owner, 2026-10-17: "ideally, it's just one call").
 *
 * ## Which part of the note
 *
 * A meaning passage is `MEANING_PASSAGE_CHARS` of the body with
 * `MEANING_PASSAGE_OVERLAP` shared with the next, so passage `n` starts
 * `n * (chars - overlap)` characters in. A database chunk is `CHUNK_CHARS`
 * with `CHUNK_OVERLAP`, so that offset sits in chunk `floor(offset / stride)`
 * at `offset % stride`, and every passage start falls inside one chunk with
 * a whole snippet after it (a chunk's stride is shorter than the chunk by
 * more than any snippet). The meaning body is trimmed and the database's is
 * not, so a passage past the first can start a character or two early: the
 * snippet is the same words either way.
 *
 * ## What is not answered here
 *
 * A note with no row is a note the database does not hold: deleted, or not
 * copied yet. `null` for it, and the caller decides: a ready database's word
 * is final, a filling one's is not (`meaning/serve.js`). A failed statement
 * answers `null` as a whole, never an empty map, so it is never read as
 * "every note is gone".
 *
 * Privacy is not decided here. Every path asked for has already passed the
 * caller's own `canSee`, at the name the tree draws, and the rows are read
 * from both tables for that reason: which table a note's chunks sit in is
 * its visibility when it was copied, and the live check above is the one
 * that counts.
 */

import { MEANING_PASSAGE_CHARS, MEANING_PASSAGE_OVERLAP } from "../meaning/project.js";
import { CHUNK_CHARS, CHUNK_OVERLAP, FTS_TABLE } from "./project.js";

const PASSAGE_STRIDE = MEANING_PASSAGE_CHARS - MEANING_PASSAGE_OVERLAP;
const CHUNK_STRIDE = CHUNK_CHARS - CHUNK_OVERLAP;

/** Where meaning passage `chunk` starts, as a database chunk and an offset into it. */
export function chunkForPassage(chunk) {
  const passage = Number.isInteger(chunk) && chunk > 0 ? chunk : 0;
  const offset = passage * PASSAGE_STRIDE;
  const ord = Math.floor(offset / CHUNK_STRIDE);
  return { ord, at: offset - ord * CHUNK_STRIDE };
}

/**
 * The statement that reads `wanted`'s chunks from both tables: one round trip.
 *
 * `path` and `ord` are UNINDEXED, so this scans the tables' rows once, which
 * measured at about ten milliseconds over fifteen thousand 4,000-character
 * chunks, under the cost of the search's own MATCH.
 */
export function passageSql(count) {
  const pairs = Array.from({ length: count }, () => "(path = ? AND ord = ?)").join(" OR ");
  const from = (table) => `SELECT path, ord, title, body FROM ${table} WHERE ${pairs}`;
  return `${from(FTS_TABLE.team)} UNION ALL ${from(FTS_TABLE.private)}`;
}

/**
 * Snippets for `matches`, by path: `{title, snippets}`, or `null` for a note
 * the database holds no row for. The whole answer is `null` when the
 * statement failed.
 *
 * @param {{query: (sql: string, params: unknown[]) => Promise<object[]>}} client
 * @param {Array<{path: string, chunk: number}>} matches
 * @param {number} chars how much of the passage a snippet shows
 * @returns {Promise<Map<string, {title: string, snippets: string[]}|null>|null>}
 */
export async function passageSnippets(client, matches, chars) {
  const wanted = new Map();
  for (const match of matches) {
    if (typeof match?.path === "string" && !wanted.has(match.path)) wanted.set(match.path, chunkForPassage(match.chunk));
  }
  const out = new Map([...wanted.keys()].map((path) => [path, null]));
  if (wanted.size === 0) return out;
  // Each note's own chunk, and its first: a passage past the note's last
  // chunk (a body shorter than the arithmetic) shows the start instead.
  const pairs = [];
  for (const [path, { ord }] of wanted) {
    pairs.push([path, ord]);
    if (ord !== 0) pairs.push([path, 0]);
  }
  const params = pairs.flat();
  let rows;
  try {
    rows = await client.query(passageSql(pairs.length), [...params, ...params]);
  } catch {
    return null;
  }
  const found = new Map();
  for (const row of rows) {
    if (typeof row?.path !== "string" || !wanted.has(row.path)) continue;
    const ord = Number(row.ord);
    const held = found.get(row.path) ?? new Map();
    // A note's chunks in one table only, unless a copy is mid-move between
    // them; either copy is the same note's words.
    if (!held.has(ord)) held.set(ord, row);
    found.set(row.path, held);
  }
  for (const [path, { ord, at }] of wanted) {
    const held = found.get(path);
    if (!held) continue;
    const row = held.get(ord) ?? held.get(0);
    if (!row) continue;
    const body = typeof row.body === "string" ? row.body : "";
    const start = held.has(ord) ? at : 0;
    const line = body.slice(start, start + chars * 2).replace(/\s+/g, " ").trim().slice(0, chars);
    const title = typeof row.title === "string" && row.title ? row.title : path.split("/").pop().replace(/\.md$/, "");
    out.set(path, { title, snippets: line ? [line] : [] });
  }
  return out;
}
