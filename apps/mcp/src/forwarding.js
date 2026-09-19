/**
 * Where a moved note went — the forwarding address a stale reference follows.
 *
 * ## The gap this closes
 *
 * `links.js` already rewrites every reference *inside* the bucket when
 * something moves: a folder rename fixes the wikilinks and the Markdown links
 * in every note that can see it, by default and without being asked. That is
 * the whole of the problem for references we can reach.
 *
 * It is none of the problem for references we cannot. A share link the owner
 * pasted into a thread last month, a deep link sitting in somebody's chat log,
 * a path an agent wrote down — none of those are in a file, so no rewrite
 * reaches them, and today every one of them dies the first time the note is
 * tidied into another folder. Worse than dying: a link minted on
 * `1-projects/foo.md` keeps pointing at that *path*, so a **different** note
 * later created there inherits an audience its author never chose.
 *
 * So the bucket remembers where things went. A move appends one entry, and a
 * holder of a stale path can be forwarded to the current one — or told the
 * trail has gone cold, which is the honest answer once the ledger has rolled.
 *
 * ## What this is not
 *
 * **It is not a reference index.** Nothing here records who points at what.
 * Storing that would mean a second copy of every link in the bucket, kept in
 * sync with files that Obsidian and `rclone` also write, and a stale copy of a
 * reference is worse than no copy: it names a relationship that no longer
 * exists. The links stay in the files, where they are canonical and where the
 * customer can read them without us (non-negotiable #3).
 *
 * **It is not the only copy of anything.** Delete this file and the bucket is
 * unchanged: every in-bucket link still resolves, because those were rewritten
 * in place at move time. What is lost is the forwarding of references held
 * elsewhere, which degrades to exactly today's behaviour — a stale link that
 * does not resolve. That is what makes it safe to cap, and safe to lose.
 *
 * **It does not rewrite a user-authored key.** A note lives where its author
 * put it (non-negotiable #2). Identity here is the *trail* between paths, kept
 * in Context-owned plumbing under `.context/`, never a rename of somebody's
 * file and never an id stamped into their frontmatter.
 *
 * ## The four rules that make it safe to consult automatically
 *
 * 1. **A folder move is one entry.** Renaming `2-areas/` to `5-areas/` writes
 *    a single prefix rule, not one row per note, so the ledger's size follows
 *    the number of *moves* rather than the number of files. A prefix matches
 *    on a segment boundary — `2-areas-old/x.md` is never carried by a rule
 *    written for `2-areas`, the same trailing-slash care `withinSharedFolder`
 *    takes in `shares.ts`.
 * 2. **Chains collapse as they are recorded.** Recording `b → c` rewrites an
 *    existing `a → b` into `a → c`. A path that has moved five times resolves
 *    in one hop, and an entry that would point at itself is dropped, so a note
 *    moved back where it started forwards nowhere rather than in a circle.
 * 3. **An exact entry outranks a folder entry.** A note that left a folder
 *    before the folder itself moved has two possible answers, and only its own
 *    is where the note actually is.
 * 4. **It is bounded, and it expires rather than breaks.** Past
 *    `FORWARDING_ENTRY_CAP` the oldest entries are dropped. An old forwarding
 *    address going cold is a link that stops working, which is today's
 *    behaviour; a ledger growing without limit would be a file every share
 *    read has to fetch.
 *
 * Nothing here talks to a store — text in, text out — so the rules are
 * testable without a bucket. `readForwarding` and `recordForwarding` are the
 * two functions that do I/O, and they hold nothing but the read and the write.
 */

import { normalizeSegments } from "./links.js";

/** Plumbing, never a note: dot-prefixed paths are not listed and not readable as notes. */
export const FORWARDING_PATH = ".context/forwarding.json";

/**
 * How many forwarding addresses are kept.
 *
 * Every share read fetches this file, so its size is a latency budget rather
 * than a storage one. A thousand entries is a few tens of kilobytes and more
 * moves than a context makes in a year — and because a folder move is one
 * entry, a person reorganising their whole PARA tree spends single digits.
 */
export const FORWARDING_ENTRY_CAP = 1000;

/**
 * How far a resolution will chain before giving up.
 *
 * Collapsing means one hop is the normal case; a folder rule feeding an exact
 * rule is two. The cap exists because the file is data — a hand-edited or
 * truncated ledger must not be able to spin this, and a bounded walk is
 * cheaper to reason about than proving acyclicity on read.
 */
const FORWARD_MAX_HOPS = 8;

const FORWARDING_VERSION = 1;

/** The empty ledger. Absent, corrupt and "no moves yet" are all this. */
function emptyState() {
  return { version: FORWARDING_VERSION, entries: [] };
}

/**
 * A bucket-relative path, or `null`.
 *
 * Shared with the link engine deliberately: a forwarding address that resolved
 * differently from a link would be a second path grammar, and the one thing
 * both must refuse is a target that climbs out of the bucket. A ledger is a
 * file in the customer's own storage, so this runs on **read** as well as on
 * write — an edited `.context/forwarding.json` is data, not a capability.
 */
function cleanPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;
  const segments = normalizeSegments(trimmed.split("/"));
  if (segments === null || segments.length === 0) return null;
  return segments.join("/");
}

function cleanKind(value) {
  return value === "folder" ? "folder" : "note";
}

/** Is `path` the folder `prefix` itself, or inside it? */
function underPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** `path` with `from` swapped for `to`, when `path` is `from` or inside it. */
function repoint(path, from, to) {
  if (path === from) return to;
  return `${to}${path.slice(from.length)}`;
}

/**
 * Read a ledger out of whatever the bucket held, without ever throwing.
 *
 * Absent, empty, corrupt, a future version, an entry missing a half, an entry
 * that climbs out of the bucket — all of them land on "no forwarding address",
 * which is the one failure mode that cannot hurt: a stale link stops resolving,
 * which is what it did before this file existed.
 */
export function parseForwarding(text) {
  if (typeof text !== "string" || text.trim() === "") return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object") return emptyState();
  // A version this code does not know is not guessed at. Dual reads are how a
  // format changes here (non-negotiable #3); until one exists, an unknown
  // version means "no forwarding addresses", never "assume the shape".
  if (parsed.version !== FORWARDING_VERSION) return emptyState();
  if (!Array.isArray(parsed.entries)) return emptyState();

  const entries = [];
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== "object") continue;
    const from = cleanPath(entry.from);
    const to = cleanPath(entry.to);
    if (from === null || to === null || from === to) continue;
    entries.push({
      from,
      to,
      kind: cleanKind(entry.kind),
      at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
    });
  }
  return { version: FORWARDING_VERSION, entries: entries.slice(-FORWARDING_ENTRY_CAP) };
}

export function serializeForwarding(state) {
  return JSON.stringify({ version: FORWARDING_VERSION, entries: state.entries });
}

/**
 * Record moves, collapsing the chains they extend.
 *
 * `moves` is `{ from, to, kind }` in the order they happened. A move whose
 * halves are equal, or whose halves are not bucket-relative paths, is ignored
 * rather than recorded — a ledger entry that forwards a path to itself is a
 * hop that resolves nowhere and a cycle waiting to be built.
 */
export function addForwarding(state, moves, { now = Date.now(), cap = FORWARDING_ENTRY_CAP } = {}) {
  let entries = state.entries.slice();
  for (const move of moves) {
    const from = cleanPath(move?.from);
    const to = cleanPath(move?.to);
    if (from === null || to === null || from === to) continue;
    const kind = cleanKind(move?.kind);

    /*
      COLLAPSE BEFORE APPENDING.

      Everything already pointing at `from` — or, for a folder, at anything
      inside it — is pointing at somewhere that has just moved again. Rewriting
      those now is what keeps resolution to one hop and what makes a cycle
      impossible to express: `a → b` followed by `b → a` rewrites the first
      entry into `a → a`, which is then dropped, rather than leaving two rules
      that chase each other.
    */
    entries = entries
      .map((entry) => {
        if (kind === "folder" ? underPrefix(entry.to, from) : entry.to === from) {
          return { ...entry, to: repoint(entry.to, from, to) };
        }
        return entry;
      })
      .filter((entry) => entry.from !== entry.to)
      // The newest rule for a path supersedes any older one, so a path never
      // has two exact answers and "newest wins" is a property of the data
      // rather than of the order something happens to scan in.
      .filter((entry) => !(entry.from === from && entry.kind === kind));

    entries.push({ from, to, kind, at: now });
  }
  return { version: FORWARDING_VERSION, entries: entries.slice(-cap) };
}

/**
 * Where `path` is now, according to the ledger.
 *
 * Returns `path` unchanged when nothing has moved it — including when the
 * ledger is empty, which is the overwhelmingly common case and costs one scan
 * of an empty array.
 */
export function forwardPath(state, path) {
  const start = cleanPath(path);
  if (start === null) return path;
  let current = start;
  const seen = new Set([current]);
  for (let hop = 0; hop < FORWARD_MAX_HOPS; hop += 1) {
    const next = forwardOnce(state.entries, current);
    if (next === null || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * One hop, and **the most specific rule wins** — never the newest.
 *
 * Rule 3 is this rule: an exact entry outranks a folder entry because it says
 * more about the path in question. The same reasoning decides between two
 * folder entries that both contain the path, and getting it from recency
 * instead is wrong in a case a bucket really reaches. Move `2-areas/apps` out
 * to `1-projects/apps`, then later rename `2-areas` to `5-areas`: the ledger
 * holds both rules, the second is newer, and it is the *first* that says where
 * `2-areas/apps/x.md` went. Longest prefix, then newest to break a tie.
 */
function forwardOnce(entries, path) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].from === path) return entries[index].to;
  }
  let best = null;
  for (const entry of entries) {
    if (entry.kind !== "folder" || !underPrefix(path, entry.from)) continue;
    if (best === null || entry.from.length >= best.from.length) best = entry;
  }
  return best === null ? null : repoint(path, best.from, best.to);
}

/* ------------------------------- the two I/O ------------------------------ */

/**
 * The ledger as the bucket holds it.
 *
 * Any failure — no object, unreadable object, a store that is down — is an
 * empty ledger. A read that threw would turn "we could not look up a
 * forwarding address" into "this share is broken", and the caller's own
 * not-found is the better answer.
 */
export async function readForwarding(store) {
  try {
    const object = await store.get(FORWARDING_PATH);
    if (object === null) return emptyState();
    return parseForwarding(await object.text());
  } catch {
    return emptyState();
  }
}

/**
 * Append moves to the ledger, and never fail the move that is recording them.
 *
 * **The write is conditional, and best-effort.** Conditional because two moves
 * landing at once would otherwise lose one of them to last-writer-wins, which
 * is the failure the store adapters exist to make impossible. Best-effort
 * because by the time this runs the objects have already moved: a lost
 * forwarding entry costs a stale link its redirect — today's behaviour — while
 * an exception here would fail an operation that has already succeeded, and
 * leave the caller believing their notes did not move.
 *
 * `onlyIf` needs an etag, and a first write has none, so an absent ledger is
 * created with `{ absent: true }` and a racing creator loses the retry rather
 * than clobbering. Stores that cannot do conditional writes (B2, Wasabi —
 * `CLAUDE.md`, "Conflict-safe writes") throw on the attempt and land in the
 * same catch as any other failure: the move stands, the address is not kept.
 */
export async function recordForwarding(store, moves, { now = Date.now(), attempts = 3 } = {}) {
  if (!Array.isArray(moves) || moves.length === 0) return false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const object = await store.get(FORWARDING_PATH);
      const state = object === null ? emptyState() : parseForwarding(await object.text());
      const next = addForwarding(state, moves, { now });
      if (next.entries.length === state.entries.length && next.entries.every((entry, index) => {
        const before = state.entries[index];
        return before && before.from === entry.from && before.to === entry.to;
      })) {
        return true; // Nothing to record — every move was a no-op.
      }
      await store.put(FORWARDING_PATH, serializeForwarding(next), {
        onlyIf: object === null ? { absent: true } : { etagMatches: object.etag },
        httpMetadata: { contentType: "application/json" },
      });
      return true;
    } catch {
      // A conditional write that lost, or a store that cannot do one at all.
      // Retry; if the attempts run out, the move keeps its outcome and the
      // forwarding address is simply not kept. See the doc comment.
    }
  }
  return false;
}
