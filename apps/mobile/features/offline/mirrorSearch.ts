import { currentEpoch } from "./epoch";
import type { CacheScope } from "./keys";
import { isNotePath, mirroredBodyAt, parseIndex, type MirrorEntry, type MirrorIndex } from "./mirror";
import type { MirrorStore } from "./mirrorStoreCore";

/**
 * Search the copy of every note that is on this device.
 *
 * The console's search asks the gateway's index (`useContextSearch`,
 * `useBlendedSearch`), which is the right answer whenever there is a
 * connection and no answer at all without one: ten seconds of "Searching the
 * rest of this context…" and then "that search could not be run", on a phone
 * that holds every note body in its mirror. Apple Notes and Obsidian both
 * search with no signal; the owner wants this app to replace them. So this
 * answers from the mirror, in the server's own result shape
 * (`SearchAnswer.hits` — path, title, snippet lines) so every surface draws it
 * unchanged.
 *
 * ## It is a derivative of a derivative, and holds nothing of its own
 *
 * Non-negotiable #3: search indexes are disposable, rebuildable, never the
 * only copy of anything. This is the most disposable thing in the folder — an
 * in-memory copy of the mirror's bodies, pre-folded for comparison, that lives
 * as long as the process and is never written anywhere. Deleting it costs one
 * slower search.
 *
 * It is **reconciled with the mirror's index on every search**, which is what
 * lets it be a cache without being a second truth. The index is the mirror's
 * commit point (`mirror.ts`), so each query reads it and keeps exactly the
 * notes it names, at the version it names: a note pruned by a sync (a grant
 * lost elsewhere, a deletion) is gone from the very next search, a changed
 * note is re-read at its new etag, and nothing the index stopped naming can be
 * found. When the index has not changed since the last search — byte for
 * byte, which is the common case while somebody types — the reconcile is
 * skipped.
 *
 * `palette.ts` argues that its ranking must never memoize, because a memo
 * would outlive the listings it came from and rank notes no longer there. The
 * argument holds here and is met differently: this memo cannot outlive its
 * source, because the source is re-read before every use. What `palette.ts`
 * ranks is a few thousand names, which costs microseconds; what this searches
 * is megabytes of bodies behind one file read each, and re-reading all of them
 * per keystroke is seconds on a phone.
 *
 * ## One clearance, one workspace, and never ciphertext
 *
 *  - **Exactly the clearance asked for.** The mirror files an index under the
 *    tier it was synced at (`keys.ts`). This reads the index at `scope` and
 *    bodies at `scope`, and nothing else — not `readableAt`'s widening, under
 *    which an owner's offline *open* may fall back to a `team` copy. A search
 *    at `team` therefore cannot see a body filed at `private`, and an owner
 *    searches the copy that was synced for them. The cost is a context whose
 *    owner was just promoted from member: offline, until the next sync, their
 *    search finds nothing while a note can still be opened from the old copy —
 *    and the status line already says nothing is on the device at `private`.
 *  - **Keyed by store, clearance and workspace, and by session.** The memo is
 *    per `(scope, workspace)` under each store instance, and it is dropped
 *    whole when `epoch.ts` says the session changed — so a sign-out empties it
 *    even before `forget.ts` gets to `forgetMirrorSearch`, and a search that
 *    was running across a sign-out answers nothing rather than the old
 *    session's notes.
 *  - **An encrypted note is skipped whole** — its body is an envelope, and a
 *    needle matched against base64 is a hit nobody can read — and counted, so
 *    the surface can say "2 encrypted notes were not searched" rather than
 *    implying it looked. Skipped by name too: "not searched" is only true if
 *    none of it was. The quick-open list still names it, because a listing
 *    already does.
 *
 * ## Matching, and ranking
 *
 * Case and accents are ignored (`fold`), every word of the query must appear
 * somewhere in the note — title, path, or body — and a word matches anywhere
 * inside a word, the way Apple Notes and Obsidian's own search do. The gateway
 * stems instead; a local search that agreed with it word for word would need
 * its tokenizer and index, and substring matching finds a superset of what a
 * stem would.
 *
 * Notes whose **title or path** carry every word come first, then notes that
 * need the body for at least one — "the note called Budget" above "a note that
 * mentions the budget", which is the order somebody typing a name expects.
 * Within each, a better name match or more occurrences wins, then the path.
 *
 * ## What it costs
 *
 * The first search after a launch reads every body once (the mirror is one
 * file per note on native, one IndexedDB record on the web); after that a
 * search is a scan over folded strings in memory. `offlineMirrorSearch.test.ts`
 * measures 3,000 synthetic notes of ~2.5KB and prints both numbers. Memory is
 * roughly twice the text of the notes searched — the original, for snippets,
 * and the folded copy — bounded per note by `MAX_SEARCHED_CHARS`.
 */

/** How many hits an answer carries. The gateway's own ceiling is fifty. */
export const DEFAULT_LIMIT = 50;

/**
 * How much of one note is searched and held in memory.
 *
 * A mailbox note can be megabytes; holding a few of those twice over would be
 * most of what this costs. Two hundred thousand characters is a very long
 * document and a small fraction of a large mailbox, and the gateway's own
 * index sheds oversized notes too — see "A shed index must say so" in
 * `docs/decisions/search.md`. A term only past the bound is a miss.
 */
export const MAX_SEARCHED_CHARS = 200_000;

/** The server's snippet width (`snippetLinesFor` in `apps/mcp/src/search/visible.js`). */
const SNIPPET_CHARS = 200;
const SNIPPET_LINES = 3;
/** How much of a long line to keep before the hit when cutting a window around it. */
const SNIPPET_LEAD = 60;

export interface DeviceSearchHit {
  path: string;
  title: string;
  snippets: string[];
}

export interface DeviceSearchAnswer {
  /** Ranked, at most `limit`. The same shape as `SearchAnswer.hits`. */
  hits: DeviceSearchHit[];
  /** Every note that matched, before the cap. */
  matchCount: number;
  /** Notes whose text was searched. */
  searched: number;
  /** Notes skipped because their body is ciphertext. */
  encryptedSkipped: number;
  /**
   * Whether an index exists for this clearance and workspace at all. `false`
   * is "nothing of this context is on this device", which a surface must say
   * rather than drawing "no matches".
   */
  mirrored: boolean;
}

/* ---------------------------------- folding ------------------------------- */

/* eslint-disable no-control-regex -- the ASCII range, deliberately. */
const NON_ASCII = /[^\x00-\x7f]/;
/** Without the `u` flag on purpose: each UTF-16 code unit, so a length is kept unit for unit. */
const NON_ASCII_UNITS = /[^\x00-\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * Folded characters, memoised. Holds single characters and never text — the
 * set is bounded by the alphabets somebody writes in.
 */
const foldedChars = new Map<string, string>();

/** One character, lowercased and without its accent, as exactly one code unit. */
function foldChar(ch: string): string {
  const known = foldedChars.get(ch);
  if (known !== undefined) return known;
  let out = ch;
  try {
    const lower = ch.toLowerCase();
    // NFD splits "é" into "e" and a combining mark; the base is what matters.
    // A character whose lowercase is longer ("İ" → "i̇") keeps its first unit,
    // so the folded text stays the same length as the original.
    const base = lower.normalize("NFD")[0];
    if (base !== undefined) out = base;
  } catch {
    // An engine without `normalize` folds case only, which is still correct
    // for every unaccented query.
    out = ch.toLowerCase()[0] ?? ch;
  }
  foldedChars.set(ch, out);
  return out;
}

/**
 * Text lowercased and stripped of accents, **at the same length**.
 *
 * The length is the point: a hit found at offset `i` in the folded text is the
 * same character at offset `i` in the original, so a snippet is cut from the
 * words somebody actually wrote rather than from their folded form. ASCII —
 * nearly all of most notes — takes the engine's own `toLowerCase`, which
 * preserves length for it; only the other characters go one by one.
 */
export function fold(text: string): string {
  const lower = text.toLowerCase();
  if (!NON_ASCII.test(lower)) return lower;
  if (lower.length === text.length) return lower.replace(NON_ASCII_UNITS, foldChar);
  // Some character lowercased to more than one unit. Fold unit by unit
  // instead: ASCII runs lowercase at their length, and `foldChar` answers one
  // unit for every other.
  return text.replace(NON_ASCII_UNITS, foldChar).replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * The words of a query, folded, in order, once each.
 *
 * Split on anything that is not a letter or a digit — which also drops the
 * combining marks of a query typed in decomposed form. One-letter words are
 * dropped unless they are all there is: "a review" means "review".
 */
export function queryTerms(query: string): string[] {
  const words = fold(query.normalize("NFC")).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const long = words.filter((word) => word.length >= 2);
  return [...new Set(long.length > 0 ? long : words)];
}

/** A note's own `#` heading, or its filename — `noteTitle` in the gateway. */
function titleOf(path: string, text: string): { title: string; line: number } {
  const lines = text.split("\n", 400);
  const at = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
  if (at !== -1) {
    return { title: lines[at]!.replace(/^#{1,6}\s+/, "").trim().slice(0, 200), line: at };
  }
  return { title: (path.split("/").pop() ?? path).replace(/\.md$/i, ""), line: -1 };
}

/* ---------------------------------- corpus -------------------------------- */

interface Doc {
  path: string;
  etag: string;
  title: string;
  /** The line the title came from, left out of snippets — it is already the row's label. */
  titleLine: number;
  foldedTitle: string;
  foldedPath: string;
  text: string;
  folded: string;
}

interface Corpus {
  /** The store it was read from — a memo from one store never answers for another. */
  store: MirrorStore;
  epoch: number;
  /** The index exactly as the store returned it, to skip a reconcile when nothing moved. */
  raw: string;
  docs: Map<string, Doc>;
  encrypted: number;
}

/** Keyed `scope␟workspace`. One process, one mirror store, so one map. */
const corpora = new Map<string, Corpus>();
/** One reconcile at a time per key, so two quick searches do not read every body twice. */
const loading = new Map<string, Promise<unknown>>();
/**
 * Bumped by every `forgetMirrorSearch`, so a reconcile that was reading while
 * a workspace was forgotten neither keeps nor answers what it read.
 */
let generation = 0;

function keyOf(scope: CacheScope, workspaceId: string): string {
  return `${scope}\u001f${workspaceId}`;
}

/**
 * Drop what is held in memory for one workspace, or for all of them.
 *
 * `forget.ts` calls it beside every clear of the mirror. The epoch check makes
 * it redundant for a sign-out and the reconcile makes it redundant for a
 * workspace whose index is gone, so this is the belt with the braces: plaintext
 * a person was just told had left the device should not sit in memory until
 * the next search happens to notice.
 */
export function forgetMirrorSearch(workspaceId?: string): void {
  generation += 1;
  for (const key of [...corpora.keys()]) {
    if (workspaceId === undefined || key.endsWith(`\u001f${workspaceId}`)) corpora.delete(key);
  }
}

function docOf(path: string, etag: string, body: string): Doc {
  const text = body.length > MAX_SEARCHED_CHARS ? body.slice(0, MAX_SEARCHED_CHARS) : body;
  const { title, line } = titleOf(path, text);
  return {
    path,
    etag,
    title,
    titleLine: line,
    foldedTitle: fold(title),
    foldedPath: fold(path),
    text,
    folded: fold(text),
  };
}

/** Bodies read at once. The store's queue is serial; this just keeps it fed. */
const READ_BATCH = 64;

async function reconcile(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
): Promise<Corpus | null> {
  const epoch = currentEpoch();
  const startedAt = generation;
  const key = keyOf(scope, workspaceId);
  let previous = corpora.get(key);
  if (previous !== undefined && (previous.epoch !== epoch || previous.store !== store)) {
    corpora.delete(key);
    previous = undefined;
  }
  /** A sign-out or a forget since this began: nothing read is kept or answered. */
  const ended = () => currentEpoch() !== epoch || generation !== startedAt;

  const raw = await store.readIndex(scope, workspaceId);
  if (ended()) return null;
  if (previous !== undefined && raw !== null && previous.raw === raw) return previous;
  const index: MirrorIndex | null = parseIndex(raw);
  if (raw === null || index === null) {
    corpora.delete(key);
    return null;
  }

  const docs = new Map<string, Doc>();
  const wanted: MirrorEntry[] = [];
  let encrypted = 0;
  for (const entry of index.entries.values()) {
    if (!entry.body || !isNotePath(entry.path)) continue;
    if (entry.encrypted === true) {
      encrypted += 1;
      continue;
    }
    const known = previous?.docs.get(entry.path);
    if (known !== undefined && known.etag === entry.etag) docs.set(entry.path, known);
    else wanted.push(entry);
  }
  for (let at = 0; at < wanted.length; at += READ_BATCH) {
    const batch = wanted.slice(at, at + READ_BATCH);
    const bodies = await Promise.all(
      batch.map((entry) => mirroredBodyAt(store, scope, workspaceId, entry)),
    );
    if (ended()) return null;
    batch.forEach((entry, n) => {
      const body = bodies[n];
      // A body the index names but the store does not have (a crash between
      // the two writes) is not searched; the next sync re-fetches it.
      if (typeof body === "string") docs.set(entry.path, docOf(entry.path, entry.etag, body));
    });
  }

  const corpus: Corpus = { store, epoch, raw, docs, encrypted };
  corpora.set(key, corpus);
  return corpus;
}

function corpusFor(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
): Promise<Corpus | null> {
  const key = keyOf(scope, workspaceId);
  const previous = loading.get(key) ?? Promise.resolve();
  const next = previous.then(
    () => reconcile(store, scope, workspaceId),
    () => reconcile(store, scope, workspaceId),
  );
  const settled = next.catch(() => null);
  loading.set(key, settled);
  void settled.then(() => {
    if (loading.get(key) === settled) loading.delete(key);
  });
  return next;
}

/* ---------------------------------- ranking ------------------------------- */

const WORD_START = /[^\p{L}\p{N}]/u;

function startsWord(haystack: string, at: number): boolean {
  return at === 0 || WORD_START.test(haystack[at - 1]!);
}

/** How well the title and path carry the terms, or `null` when some term is not in either. */
function nameScore(doc: Doc, terms: readonly string[], whole: string): number | null {
  let score = doc.foldedTitle === whole ? 20 : 0;
  for (const term of terms) {
    const inTitle = doc.foldedTitle.indexOf(term);
    if (inTitle === 0) score += 4;
    else if (inTitle > 0) score += startsWord(doc.foldedTitle, inTitle) ? 3 : 2;
    else if (doc.foldedPath.includes(term)) score += 1;
    else return null;
  }
  return score;
}

/** Occurrences of `term` in `text`, stopping at `cap`. */
function occurrences(text: string, term: string, cap: number): number {
  let count = 0;
  for (let at = text.indexOf(term); at !== -1 && count < cap; at = text.indexOf(term, at + term.length)) {
    count += 1;
  }
  return count;
}

interface Ranked {
  doc: Doc;
  /** 0 — every term in the title or path; 1 — the body was needed. */
  tier: 0 | 1;
  score: number;
  first: number;
}

function rankDoc(doc: Doc, terms: readonly string[], whole: string): Ranked | null {
  const byName = nameScore(doc, terms, whole);
  if (byName !== null) return { doc, tier: 0, score: byName, first: 0 };
  let score = 0;
  let first = Number.MAX_SAFE_INTEGER;
  for (const term of terms) {
    const inName = doc.foldedTitle.includes(term) || doc.foldedPath.includes(term);
    const at = doc.folded.indexOf(term);
    if (at === -1 && !inName) return null;
    if (at !== -1) {
      first = Math.min(first, at);
      score += occurrences(doc.folded, term, 10);
    }
    if (inName) score += 3;
  }
  return { doc, tier: 1, score, first };
}

function compare(a: Ranked, b: Ranked): number {
  return (
    a.tier - b.tier ||
    b.score - a.score ||
    a.first - b.first ||
    a.doc.path.length - b.doc.path.length ||
    (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0)
  );
}

/* ---------------------------------- snippets ------------------------------ */

/**
 * Up to three lines that carry a term, as the gateway's `snippetLinesFor` cuts
 * them — trimmed, at most 200 characters — except that a long line is cut
 * *around* the hit rather than from its start, so a word three hundred
 * characters into a paragraph is on screen rather than past the cut.
 */
function snippetsOf(doc: Doc, terms: readonly string[]): string[] {
  const lines = doc.text.split("\n");
  const folded = doc.folded.split("\n");
  const out: string[] = [];
  for (let n = 0; n < lines.length && out.length < SNIPPET_LINES; n += 1) {
    if (n === doc.titleLine) continue;
    const line = lines[n]!;
    const foldedLine = folded[n] ?? "";
    let hit = -1;
    for (const term of terms) {
      const at = foldedLine.indexOf(term);
      if (at !== -1 && (hit === -1 || at < hit)) hit = at;
    }
    if (hit === -1 || line.trim() === "") continue;
    const trimmed = line.trim();
    if (trimmed.length <= SNIPPET_CHARS) {
      out.push(trimmed);
      continue;
    }
    const start = Math.max(0, hit - SNIPPET_LEAD);
    const window = line.slice(start, start + SNIPPET_CHARS).trim();
    out.push(`${start > 0 ? "…" : ""}${window}${start + SNIPPET_CHARS < line.length ? "…" : ""}`);
  }
  return out;
}

/* ---------------------------------- search -------------------------------- */

/**
 * Search the mirror of one context, at one clearance.
 *
 * Never throws: a store that cannot be read is a context with nothing on the
 * device, which is what `mirrored: false` says.
 */
export async function searchMirror(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  query: string,
  options: { limit?: number } = {},
): Promise<DeviceSearchAnswer> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  let corpus: Corpus | null;
  try {
    corpus = await corpusFor(store, scope, workspaceId);
  } catch {
    corpus = null;
  }
  if (corpus === null) {
    return { hits: [], matchCount: 0, searched: 0, encryptedSkipped: 0, mirrored: false };
  }
  const terms = queryTerms(query);
  const base = {
    searched: corpus.docs.size,
    encryptedSkipped: corpus.encrypted,
    mirrored: true,
  };
  if (terms.length === 0) return { hits: [], matchCount: 0, ...base };

  const whole = terms.join(" ");
  const ranked: Ranked[] = [];
  for (const doc of corpus.docs.values()) {
    const match = rankDoc(doc, terms, whole);
    if (match !== null) ranked.push(match);
  }
  ranked.sort(compare);
  return {
    hits: ranked.slice(0, limit).map(({ doc }) => ({
      path: doc.path,
      title: doc.title,
      snippets: snippetsOf(doc, terms),
    })),
    matchCount: ranked.length,
    ...base,
  };
}
