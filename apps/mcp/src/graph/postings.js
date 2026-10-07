// Posting pages: the reverse side of the link graph (arch 9.1, 9.3). A posting
// is a chain of pages `0.json`, `1.json`, ... under one directory; page 0 is the
// head and a missing head is an empty list. All store ops go through a budget.
import { postingPageKey } from "./keys.js";
import { POSTING_PAGE_SIZE, parsePage, recordText, serializePage } from "./records.js";

// OPEN-9: attempts per membership change, the same count
// `projectWrittenNoteAfterResponse` uses. Contention past this is left to
// reconciliation and reported as "conflict".
export const MAX_ATTEMPTS = 3;

// Page-walk cap. Arch 9.1 asks for "bounded pages"; at POSTING_PAGE_SIZE (256)
// entries a page, 64 pages is 16,384 sources for one target, far past any real
// note's incoming count, while a walk stays at most 64 reads. A chain longer
// than this is treated as malformed or hostile: readers report incomplete and
// writers refuse to append.
export const MAX_POSTING_PAGES = 64;

const sameEntry = (a, b) => a.source === b.source && a.referenceSetVersion === b.referenceSetVersion;

/**
 * Walk the chain from the head. Follows `next` only when it is exactly the
 * current page number plus one (a bucket writer cannot make it loop or skip)
 * and stops at MAX_POSTING_PAGES. A missing page that the previous page links
 * to (or a missing head) is an empty slot with `etag: null`.
 * Returns `{ slots, status }`, status one of "end", "budget", "malformed"
 * (bad `next` or cap hit) or "corrupt" (an unparseable page, kept as an empty
 * slot; writers must not write through it, it would drop its `next`).
 */
async function walk(store, budget, { gen, family, hash }) {
  const slots = [];
  for (let n = 0; ; n += 1) {
    if (n >= MAX_POSTING_PAGES) return { slots, status: "malformed" };
    if (!budget.take()) return { slots, status: "budget" };
    const key = postingPageKey(gen, family, hash, n);
    const got = await store.get(key);
    if (!got) {
      slots.push({ n, key, etag: null, entries: [] });
      return { slots, status: "end" };
    }
    const page = parsePage(await recordText(got), key);
    if (!page) {
      slots.push({ n, key, etag: got.etag, entries: [] });
      return { slots, status: "corrupt" };
    }
    slots.push({ n, key, etag: got.etag, entries: page.entries, next: page.next });
    if (page.next === undefined) return { slots, status: "end" };
    if (page.next !== String(n + 1)) return { slots, status: "malformed" };
  }
}

/**
 * Set (present) or clear (not present) `source` in the posting. With `exact`
 * (clear only), only entries naming exactly this `referenceSetVersion` are
 * removed, so the reconciliation audit never drops another entry of the same
 * source that `validateEntry` may accept. Returns
 * "done", "conflict" (refused MAX_ATTEMPTS times, or the walk did not reach a clean
 * end of chain, an unparseable page or a bad `next` or the read cap: nothing is written and reconciliation must repair it),
 * "budget" (the budget cannot cover the read or every planned write; nothing
 * from this attempt is written) or "full" (the chain is at MAX_POSTING_PAGES
 * and the entry cannot be added; callers mark coverage partial).
 */
export async function setMembership(store, budget, { gen, family, hash, source, referenceSetVersion, present, mode, exact = false }) {
  const conditional = mode === "conditional";
  const entry = { source, referenceSetVersion };
  const match = !present && exact ? (e) => sameEntry(e, entry) : (e) => e.source === source;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { slots, status } = await walk(store, budget, { gen, family, hash });
    if (status === "budget") return "budget";
    // Anything but a clean end of chain (corrupt page, bad `next`, read cap):
    // the walk may not have reached `source`, so write nothing.
    if (status !== "end") return "conflict";
    const mine = slots.flatMap((s) => s.entries.filter(match));
    if (mine.length === 1 && present && sameEntry(mine[0], entry)) return "done";
    if (mine.length === 0 && !present) return "done";

    const changed = new Set();
    for (const s of slots) {
      const kept = s.entries.filter((e) => !match(e));
      if (kept.length !== s.entries.length) {
        s.entries = kept;
        changed.add(s);
      }
    }
    let ordered;
    if (present) {
      const room = slots.find((s) => s.entries.length < POSTING_PAGE_SIZE);
      if (room) {
        room.entries = [...room.entries, entry];
        changed.delete(room);
        ordered = [room, ...changed];
      } else {
        // Every walked page is full. Past the cap a new page would be unreachable.
        const last = slots[slots.length - 1];
        if (last.n + 1 >= MAX_POSTING_PAGES) return "full";
        const n = last.n + 1;
        const fresh = { n, key: postingPageKey(gen, family, hash, n), etag: null, entries: [entry] };
        last.next = String(n);
        changed.delete(last);
        // Link before create: a reader that follows a link to a missing page
        // just ends the chain, and a retry finds the slot instead of an orphan.
        ordered = [last, fresh, ...changed];
      }
    } else {
      ordered = [...changed];
    }

    // Never start a multi-page change the budget cannot finish.
    if (budget.remaining < ordered.length) return "budget";
    let refused = false;
    for (const s of ordered) {
      if (!budget.take()) return "budget";
      const page = { key: s.key, entries: s.entries, ...(s.next !== undefined && { next: s.next }) };
      const options = !conditional ? undefined : { onlyIf: s.etag ? { etagMatches: s.etag } : { absent: true } };
      if (!(await store.put(s.key, serializePage(page), options))) {
        refused = true;
        break;
      }
    }
    if (!refused) return "done";
    // Best effort writes are never refused; a refusal there is a store fault,
    // and a retry re-reads and re-merges just the same.
  }
  return "conflict";
}

/**
 * Visible, validated entries of the posting. `canSee` runs on each entry before
 * anything is collected or validated (arch 2.3), so a hidden source changes
 * neither the result nor what `validate` is asked. `complete` is false when the
 * budget ran out, the chain was malformed or capped, or validation threw.
 */
export async function readPostings(store, budget, { gen, family, hash, canSee, validate }) {
  const { slots, status } = await walk(store, budget, { gen, family, hash });
  let complete = status === "end";
  const entries = [];
  // One entry per source, the last in chain order winning (a transient
  // duplicate exists while a re-add moves between pages).
  const latest = new Map();
  for (const s of slots) for (const e of s.entries) latest.set(e.source, e);
  for (const e of latest.values()) {
    if (!(await canSee(e.source))) continue;
    try {
      if (await validate(e)) entries.push({ source: e.source, referenceSetVersion: e.referenceSetVersion });
    } catch {
      complete = false;
    }
  }
  return { entries, complete };
}
