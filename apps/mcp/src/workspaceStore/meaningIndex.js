/**
 * A workspace object's own meaning index: each note's passages (`search/meaning/project.js` `meaningPassages`), their
 * fingerprints from the same model (`@cf/baai/bge-m3`), kept beside the notes, so a search by meaning is the query's
 * embedding and one call to the object instead of a round trip to Vectorize over Cloudflare's HTTP API (decided
 * 2026-11-03: Dev chose that every search waits for its meaning results, so they have to be fast;
 * `docs/decisions/search/object-meaning-index.md`).
 *
 * ## Kept small, scanned whole
 *
 * Each passage is kept twice, both derived from its unit-length fingerprint: one bit a dimension (its sign, 128 bytes)
 * and one byte a dimension (`q`, 1 KB, with its scale). A query reads every passage's bits from memory and keeps the
 * `CANDIDATES` closest by Hamming distance, then scores those by their bytes against the query's own numbers: the
 * cosine the search database's index gives, within the bytes' rounding. A workspace of 40,000 passages is 5 MB of
 * bits held in memory, and its scan is a few milliseconds.
 *
 * ## Caught up behind, never in front
 *
 * The same change log as the word index (`changeLog.js`), under its own name, says which rows changed. Catching up
 * asks the model, so it never runs in front of an answer: `ws.meaning.build` does it behind a response, at most
 * `BUILD_PASSAGES` passages a call, and the object answers other calls while it waits on the model. A query is served
 * once the first build has finished, from what is held: a note saved a moment ago ranks by its last fingerprint until
 * the next build, as it did in Vectorize. Who may see a match is the gateway's live `canSee`, after this answers.
 *
 * Nothing here is the only copy of anything; dropping these tables loses nothing.
 */

import { effectiveVisibility } from "../privacy/engine.js";
import { isIndexableNote } from "../search/indexable.js";
import { meaningPassages, meaningTierFor } from "../search/meaning/project.js";
import { MEANING_DIMENSIONS } from "../search/meaning/embed.js";
import { parsedRules } from "./serve.js";
import { TEX_TABLES, texObjects } from "../texStore/objects.js";
import { changeLog, PERSON_TEX_KEY } from "./changeLog.js";

/** Passages one build call embeds (16 model calls of 32); the object answers other calls while it waits on them. */
export const BUILD_PASSAGES = 512;
/** Matches a query answers with, as the search database's index does (`client.js` `QUERY_TOP_K`). */
export const QUERY_TOP_K = 50;
/** Passages scored by their bytes after the bits' scan. */
export const CANDIDATES = 400;
const WORDS = MEANING_DIMENSIONS / 32;
/** The index's own layout; an index from an earlier one is emptied and built again. */
const LAYOUT = "1";
const TIERS = ["private", "team"];
/** Ids per `IN (...)`: a Durable Object binds at most 100 parameters a statement. */
const IN_BATCH = 90;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_meaning_passages (
    id INTEGER PRIMARY KEY,
    row_id TEXT NOT NULL,
    path TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    tier TEXT NOT NULL,
    bits BLOB NOT NULL,
    q BLOB NOT NULL,
    scale REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ws_meaning_passages_row ON ws_meaning_passages (row_id)`,
  // What each row's passages were made from: a row whose text is the same is moved or re-tiered, never embedded again.
  `CREATE TABLE IF NOT EXISTS ws_meaning_held (row_id TEXT PRIMARY KEY, path TEXT NOT NULL, etag TEXT NOT NULL, tier TEXT)`,
  `CREATE TABLE IF NOT EXISTS ws_meaning_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export class MeaningAskRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "MeaningAskRefused";
  }
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** Where a live row's text is in this object (as the word index reads it, `searchIndex.js`), or `null`. */
function textAt(row) {
  const key = row.storage_key ?? (typeof row.note_id === "string" ? `notes/${row.note_id}.md` : null);
  if (typeof key !== "string") return null;
  if (key.startsWith("notes/")) return { key, tex: false };
  const tex = PERSON_TEX_KEY.exec(key);
  return tex ? { key: tex[1], tex: true } : null;
}

/** `values` at unit length, or `null` where it is not a whole fingerprint. */
function unit(values) {
  if (!Array.isArray(values) && !(values instanceof Float32Array)) return null;
  if (values.length !== MEANING_DIMENSIONS) return null;
  let norm = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    norm += value * value;
  }
  if (norm === 0) return null;
  const scale = 1 / Math.sqrt(norm);
  const out = new Float32Array(MEANING_DIMENSIONS);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] * scale;
  return out;
}

/** One bit a dimension: set where the number is above zero. */
export function signBits(vector) {
  const bits = new Uint32Array(WORDS);
  for (let i = 0; i < MEANING_DIMENSIONS; i += 1) if (vector[i] > 0) bits[i >>> 5] |= 1 << (i & 31);
  return bits;
}

/** One byte a dimension, and the scale that turns a byte back into the number. */
export function quantized(vector) {
  let max = 0;
  for (let i = 0; i < vector.length; i += 1) max = Math.max(max, Math.abs(vector[i]));
  const scale = max === 0 ? 0 : max / 127;
  const q = new Int8Array(vector.length);
  if (scale > 0) for (let i = 0; i < vector.length; i += 1) q[i] = Math.round(vector[i] / scale);
  return { q, scale };
}

function popcount(x) {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

const bytesOf = (blob) => (blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : new Uint8Array(blob ?? []));

/**
 * The meaning index over `sql`, beside `rows` (`rows.js`) and `objects` (the notes' text).
 *
 * @param {{exec: (query: string, ...binds: unknown[]) => {toArray(): object[]}}} sql
 * @param {{rows: object, objects: {get(key: string): object|null}, embed: ((texts: string[]) => Promise<number[][]>)|null}} held
 *   `embed` is the model (`search/meaning/embed.js` `bindingEmbedder`); `null` where this Worker has none, and then
 *   nothing is built.
 */
export function workspaceMeaning(sql, { rows, objects, embed }) {
  const log = changeLog(sql, "ws_meaning");
  const meta = (name) => all(sql.exec("SELECT value FROM ws_meaning_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_meaning_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);

  let ready = false;
  const schema = () => {
    if (!ready) {
      for (const statement of SCHEMA) sql.exec(statement);
      log.ensure();
      if (meta("layout") !== LAYOUT) {
        sql.exec("DELETE FROM ws_meaning_passages");
        sql.exec("DELETE FROM ws_meaning_held");
        sql.exec("DELETE FROM ws_meaning_meta");
        log.clearKeys();
        log.markAll("SELECT row_id FROM ws_meaning_held");
        setMeta("layout", LAYOUT);
      }
      ready = true;
    }
    log.ensure();
  };

  let texHeld = null;
  const texNotes = () => (texHeld ??= texObjects(sql, { tables: TEX_TABLES }));

  // The bits of every passage, in memory: loaded on the first query, kept level by every write here after it.
  let held = null;
  let packed = null;
  const load = () => {
    if (held !== null) return held;
    held = new Map();
    for (const row of all(sql.exec("SELECT id, path, chunk, tier, bits FROM ws_meaning_passages"))) {
      const bytes = bytesOf(row.bits);
      held.set(Number(row.id), { path: row.path, chunk: Number(row.chunk), tier: row.tier, bits: new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + WORDS * 4)) });
    }
    packed = null;
    return held;
  };
  const pack = () => {
    if (packed !== null) return packed;
    const entries = [...load()];
    const ids = new Float64Array(entries.length);
    const bits = new Uint32Array(entries.length * WORDS);
    const tiers = new Uint8Array(entries.length);
    entries.forEach(([id, entry], index) => {
      ids[index] = id;
      bits.set(entry.bits, index * WORDS);
      tiers[index] = TIERS.indexOf(entry.tier);
    });
    packed = { ids, bits, tiers, entries: entries.map(([, entry]) => entry) };
    return packed;
  };
  const forgetRow = (rowId) => {
    if (held !== null) for (const row of all(sql.exec("SELECT id FROM ws_meaning_passages WHERE row_id = ?", rowId))) held.delete(Number(row.id));
    packed = null;
    sql.exec("DELETE FROM ws_meaning_passages WHERE row_id = ?", rowId);
    sql.exec("DELETE FROM ws_meaning_held WHERE row_id = ?", rowId);
  };

  /** What a row should be indexed as now: its path, text, tier; `null` where it has no passages to keep. */
  const wantFor = (rowId, rules, overrides) => {
    const live = all(sql.exec("SELECT path, storage_key, note_id, kind, gone FROM ws_rows WHERE id = ?", rowId))[0] ?? null;
    if (!live || Number(live.gone) !== 0 || live.kind !== "file" || !isIndexableNote(live.path)) return null;
    const where = textAt(live);
    if (where === null || (where.tex && !log.texReady)) return null;
    const text = all(sql.exec(`SELECT etag FROM ${where.tex ? TEX_TABLES.objects : "objects"} WHERE key = ?`, where.key))[0];
    if (text === undefined) return null;
    const tier = meaningTierFor(effectiveVisibility(live.path, rules, overrides)) ?? null;
    return { path: live.path, ...where, etag: text.etag, tier };
  };

  /** Keep `vectors` (one per passage) as the row's passages, in place of what it had. */
  const keep = (rowId, want, vectors) => {
    forgetRow(rowId);
    vectors.forEach((values, chunk) => {
      const vector = unit(values);
      if (vector === null) return;
      const bits = signBits(vector);
      const { q, scale } = quantized(vector);
      sql.exec(
        "INSERT INTO ws_meaning_passages (row_id, path, chunk, tier, bits, q, scale) VALUES (?, ?, ?, ?, ?, ?, ?)",
        rowId, want.path, chunk, want.tier, new Uint8Array(bits.buffer), new Uint8Array(q.buffer), scale,
      );
      if (held !== null) {
        const id = Number(all(sql.exec("SELECT last_insert_rowid() AS id"))[0]?.id);
        held.set(id, { path: want.path, chunk, tier: want.tier, bits });
      }
    });
    sql.exec("INSERT INTO ws_meaning_held (row_id, path, etag, tier) VALUES (?, ?, ?, ?)", rowId, want.path, want.etag, want.tier);
    packed = null;
  };

  let running = false;

  /**
   * Bring the index up to the notes, embedding at most `passages` passages, and say how many changes are still
   * waiting: `{waiting}`, `{busy: true}` while another build runs here, `null` with no member rules or no model.
   */
  const catchUp = async ({ passages: budget = BUILD_PASSAGES } = {}) => {
    schema();
    if (typeof embed !== "function") return null;
    const rules = rows.rules("member");
    if (rules === null) return null;
    if (running) return { busy: true, waiting: log.pending() };
    running = true;
    try {
      const stamp = JSON.stringify([rules.accessVersion ?? null, rules.etag ?? null]);
      if (meta("rules") !== stamp) {
        log.markAll("SELECT row_id FROM ws_meaning_held");
        setMeta("rules", stamp);
      }
      const { rules: parsed, overrides } = parsedRules(rules);
      log.keysToRows();
      let spent = 0;
      while (spent < budget) {
        const ids = log.take(50);
        if (ids.length === 0) break;
        let full = false;
        for (const rowId of ids) {
          const want = wantFor(rowId, parsed, overrides);
          const was = all(sql.exec("SELECT path, etag, tier FROM ws_meaning_held WHERE row_id = ?", rowId))[0] ?? null;
          if (want === null || want.tier === null) {
            if (was !== null) forgetRow(rowId);
            log.done(rowId);
            continue;
          }
          if (was !== null && was.etag === want.etag) {
            // The same text: moved or re-tiered, never embedded again.
            if (was.path !== want.path || was.tier !== want.tier) {
              sql.exec("UPDATE ws_meaning_passages SET path = ?, tier = ? WHERE row_id = ?", want.path, want.tier, rowId);
              sql.exec("UPDATE ws_meaning_held SET path = ?, tier = ? WHERE row_id = ?", want.path, want.tier, rowId);
              // Read again on the next query: a move or a change of rules is rare beside a search.
              held = null;
              packed = null;
            }
            log.done(rowId);
            continue;
          }
          const found = (want.tex ? texNotes() : objects).get(want.key);
          const texts = found && found.body !== undefined ? meaningPassages(want.path, new TextDecoder().decode(found.body)) : [];
          if (spent > 0 && spent + texts.length > budget) {
            full = true;
            break;
          }
          // Off the log before the model is asked: a change while it answers puts the row back.
          log.done(rowId);
          let vectors;
          try {
            vectors = texts.length === 0 ? [] : await embed(texts);
          } catch (error) {
            // The model failed: the row waits for the next build, and this one stops.
            log.again(rowId);
            throw error;
          }
          spent += texts.length;
          // Written only if the row is still what was embedded; otherwise its change is already on the log.
          const now = wantFor(rowId, parsed, overrides);
          if (now === null || now.etag !== want.etag || now.path !== want.path) continue;
          keep(rowId, want, vectors);
        }
        if (full) break;
      }
      const waiting = log.pending();
      if (waiting === 0 && meta("complete") === null) setMeta("complete", String(Date.now()));
      return { waiting };
    } finally {
      running = false;
    }
  };

  return {
    /** Catch up behind a response (see `catchUp`). */
    catchUp,

    /**
     * The passages closest to `vector`: `{served: true, matches: [{id, score, path, chunk, tier}]}` best first, as the
     * search database's index answers (`client.js` `query`); `{served: false, waiting}` until the first build has
     * finished. `tiers` narrows to passages written at those tiers, a ranking aid and never the access check.
     */
    query(vector, { tiers = null, topK = QUERY_TOP_K } = {}) {
      const asked = unit(vector);
      if (asked === null) throw new MeaningAskRefused("a query is one whole fingerprint");
      if (tiers !== null && (!Array.isArray(tiers) || tiers.some((tier) => !TIERS.includes(tier)))) throw new MeaningAskRefused("tiers are private or team");
      const limit = Number(topK);
      if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_TOP_K) throw new MeaningAskRefused(`a query asks for 1 to ${QUERY_TOP_K} matches`);
      schema();
      if (meta("complete") === null) return { served: false, waiting: log.pending() };
      const index = pack();
      const allowed = tiers === null ? null : new Set(tiers.map((tier) => TIERS.indexOf(tier)));
      const want = signBits(asked);
      const count = index.ids.length;
      // Hamming distance of each passage's bits from the query's, and the distance the closest `CANDIDATES` are within.
      const distance = new Uint16Array(count);
      const histogram = new Uint32Array(MEANING_DIMENSIONS + 2);
      for (let i = 0; i < count; i += 1) {
        if (allowed !== null && !allowed.has(index.tiers[i])) {
          distance[i] = MEANING_DIMENSIONS + 1;
          continue;
        }
        let d = 0;
        const base = i * WORDS;
        for (let w = 0; w < WORDS; w += 1) d += popcount(index.bits[base + w] ^ want[w]);
        distance[i] = d;
        histogram[d] += 1;
      }
      let cutoff = 0;
      for (let seen = 0; cutoff <= MEANING_DIMENSIONS && seen + histogram[cutoff] < CANDIDATES; cutoff += 1) seen += histogram[cutoff];
      const picked = [];
      for (let i = 0; i < count && picked.length < CANDIDATES; i += 1) if (distance[i] <= cutoff && distance[i] <= MEANING_DIMENSIONS) picked.push(i);
      // Scored by their bytes: the cosine within rounding.
      const scored = [];
      for (let start = 0; start < picked.length; start += IN_BATCH) {
        const group = picked.slice(start, start + IN_BATCH);
        const ids = group.map((i) => index.ids[i]);
        const bytes = new Map(all(sql.exec(`SELECT id, q, scale FROM ws_meaning_passages WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids)).map((row) => [Number(row.id), row]));
        for (const i of group) {
          const row = bytes.get(index.ids[i]);
          if (!row) continue;
          const q = new Int8Array(bytesOf(row.q).slice().buffer);
          let dot = 0;
          for (let d = 0; d < MEANING_DIMENSIONS; d += 1) dot += asked[d] * q[d];
          const entry = index.entries[i];
          scored.push({ id: String(index.ids[i]), score: dot * Number(row.scale), path: entry.path, chunk: entry.chunk, tier: entry.tier });
        }
      }
      scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.chunk - b.chunk));
      return { served: true, matches: scored.slice(0, limit) };
    },

    /** Changes waiting, and whether the first build has finished. */
    state() {
      schema();
      return { waiting: log.pending(), complete: meta("complete") !== null, passages: Number(all(sql.exec("SELECT COUNT(*) AS n FROM ws_meaning_passages"))[0]?.n ?? 0) };
    },
  };
}
