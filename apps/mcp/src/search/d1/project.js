/**
 * Turning one note into the rows that answer a search about it.
 *
 * ## Why this lives in the gateway and not the control plane
 *
 * The gateway already owns search: `visible.js` is the one implementation that
 * `search_notes`, the ChatGPT-dialect `search` and the console all run, because
 * "a second path is a second place for a visibility bug". A D1 projection built
 * in the control plane and queried in the gateway would be exactly that second
 * path — two codebases agreeing about what a chunk is, what a field weight
 * means, and which table a private note belongs in, with nothing running both.
 *
 * So the control plane provisions the database and deletes it, and everything
 * that decides *content* is here. It costs the control plane's backfill the
 * ability to run long — which is fine, because the R2 index already solves that
 * with bounded passes behind the response, and this rides the same mechanism.
 *
 * ## What a note becomes
 *
 * One `notes` row, and one `*_fts` row per chunk. Chunks overlap, and the
 * overlap is not a nicety: a phrase straddling a boundary would be in neither
 * chunk as a phrase, so a two-word search for it would miss — a false negative
 * caused purely by where the arithmetic fell.
 *
 * **The 2,048-character cap does not exist here.** `NOTE_INDEX_CHAR_CAP` is the
 * R2 index's, forced by having to parse a whole shard into a 128MB heap; a row
 * per chunk has no such ceiling. The search-performance note calls that cap the
 * largest remaining source of a search that does not find something that is
 * there, and this is where it goes away.
 *
 * ## Which table
 *
 * A note's effective visibility decides, and the split is for **corpus
 * statistics**, not access — see `docs/decisions/search.md`. The visibility
 * recorded here is `privacy.md` as it was at index time and may be stale, so
 * `canSee` still filters every result before it leaves.
 */

import { extractFields } from "../indexer.js";

/**
 * Characters per chunk, and the overlap between them.
 *
 * D1's row limit is 2MB, so this is far below any hard constraint; the number
 * is chosen for *ranking* rather than for storage. BM25 normalizes by document
 * length, and a "document" here is a chunk — so an enormous chunk buries a term
 * that a small one would rank highly, and a tiny one makes every chunk look
 * dense. Four thousand characters is roughly a long section of a note.
 */
export const CHUNK_CHARS = 4_000;
export const CHUNK_OVERLAP = 200;

/**
 * Split text into overlapping chunks.
 *
 * Always at least one chunk, even for empty text: a note with no body still has
 * a title and a path worth matching, and a note with zero rows would be a note
 * that exists in `notes` and cannot be found.
 */
export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  if (typeof text !== "string" || text.length === 0) return [""];
  if (text.length <= size) return [text];
  // At least one character of stride whatever the arguments, so a mistaken
  // overlap is a slow index rather than a loop that never ends.
  const stride = Math.max(1, size - Math.max(0, overlap));
  const chunks = [];
  for (let start = 0; start < text.length; start += stride) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}

/**
 * The rows one note becomes.
 *
 * @param {string} path bucket-relative, e.g. `1-projects/foo.md`
 * @param {{version: string, uploaded: string|null, visibility: "private"|"team", content: string}} note
 * @returns {{note: object, chunks: object[]}}
 */
export function projectNote(path, note) {
  const { version, uploaded = null, visibility, content } = note;
  const fields = extractFields(path, content);

  // Chunked on the BODY only. Title, headings and tags are small, bounded, and
  // the highest-weighted fields — repeating them on every chunk is what lets a
  // hit deep in a long note still carry the note's title into the ranking, and
  // costs a few hundred bytes per chunk to do it.
  const bodies = chunkText(fields.body);
  const tags = fields.tags.join(" ");

  const chunks = bodies.map((body, ord) => ({
    path,
    ord,
    title: fields.title,
    headings: fields.headings,
    tags,
    body,
  }));

  return {
    note: {
      path,
      version,
      visibility,
      title: fields.title,
      uploaded,
      chunks: chunks.length,
      indexed_at: new Date().toISOString(),
    },
    chunks,
  };
}

/** The FTS table a visibility's rows live in. */
export const FTS_TABLE = {
  private: "notes_private_fts",
  team: "notes_team_fts",
};

/**
 * The statements that replace one note's rows, in order.
 *
 * **Delete from both tables, always.** A note whose visibility changed from
 * private to team has rows in the other table, and deleting only from the one
 * it now belongs to would leave the old rows behind — a private-tier copy of a
 * note that is now team, or worse, a team-tier copy of a note that has just
 * been made private, which the live `canSee` would filter but whose *terms*
 * would still shift a team caller's ranking. Two cheap deletes close that.
 *
 * Returned as `{sql, params}` pairs rather than executed, so the caller owns
 * batching and the budget — and so this is testable without a database.
 */
export function upsertStatements(path, projected) {
  const statements = [
    { sql: `DELETE FROM notes WHERE path = ?`, params: [path] },
    { sql: `DELETE FROM ${FTS_TABLE.private} WHERE path = ?`, params: [path] },
    { sql: `DELETE FROM ${FTS_TABLE.team} WHERE path = ?`, params: [path] },
    {
      sql: `INSERT INTO notes (path, version, visibility, title, uploaded, chunks, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        projected.note.path,
        projected.note.version,
        projected.note.visibility,
        projected.note.title,
        projected.note.uploaded,
        projected.note.chunks,
        projected.note.indexed_at,
      ],
    },
  ];

  const table = FTS_TABLE[projected.note.visibility];
  // An unknown visibility is a programming error, and the safe failure is to
  // index nothing rather than to guess a table — guessing `team` publishes a
  // private note's vocabulary to every member of the context.
  if (table === undefined) return statements;

  for (const chunk of projected.chunks) {
    statements.push({
      sql: `INSERT INTO ${table} (path, ord, title, headings, tags, body)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [chunk.path, chunk.ord, chunk.title, chunk.headings, chunk.tags, chunk.body],
    });
  }
  return statements;
}

/** Remove a note entirely — a delete, or the old half of a move. */
export function deleteStatements(path) {
  return [
    { sql: `DELETE FROM notes WHERE path = ?`, params: [path] },
    { sql: `DELETE FROM ${FTS_TABLE.private} WHERE path = ?`, params: [path] },
    { sql: `DELETE FROM ${FTS_TABLE.team} WHERE path = ?`, params: [path] },
  ];
}
