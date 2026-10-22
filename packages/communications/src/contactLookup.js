// Finding a person's contact page by who they are, not by where it was first put.
//
// ## Why a lookup, and not a path
//
// A contact page's key used to be recomputed from an identifier on every sync,
// and read and written there. That made the key the identity: the moment the
// owner filed a page under `c/`, renamed it to `claire-dubois.md` or merged
// her email page into her phone page, the next message recreated a page at the
// old address. The owner wants `0-inbox/contacts/<letter>/` kept tidy by the
// app as mail and iMessages keep arriving (2026-10-12), so a page is found by
// the identifiers written on it, wherever it is, and only a person nobody has
// a page for gets a new one — under the letter of their name.
//
// ## What the lookup is
//
// An identifier → path map over every page one folder deep under the contacts
// folder and its archive mirror, built from **one prefix listing each** and
// the pages themselves. Each entry remembers the listing's version of the page
// it was read at (an etag, or whatever the caller's listing reports), so a page
// is read again only when it changed, appeared, or moved. The map can be
// handed back as a snapshot and kept by the caller between runs — the gateway
// keeps it at `CONTACT_INDEX_KEY` — and that copy is a **disposable
// derivative**: the identifiers live on the pages, a missing or unreadable
// snapshot is an empty one, and the next listing corrects any entry the
// bucket disagrees with.
//
// The archive is searched too. A page with no activity for a year is filed at
// the same path under `4-archive/` (owner, 2026-10-12; the sweep that files it
// is `contactDormancy.js`, fed by what this map remembers), and a message for that
// person moves it back — through the caller's ordinary move, so links follow —
// before merging, rather than starting them a second, empty page.
//
// Routing is decided here, once, for every sync writer (`upsertContactDraft`);
// what may be written is still `mergeContactNote`'s answer, and whether a page
// may be created at all is `shouldCreateContactPage`'s.

import { CONTACTS_FOLDER, INBOX_FOLDER, LEGACY_INBOX_FOLDER } from "./protocol.js";
import { CONTACT_ARCHIVE_FOLDER, isContactNotePath, liveContactPathForArchived, normalizeRoot } from "./paths.js";
import {
  contactPathForDraft,
  identifierSet,
  isContactNote,
  mergeContactNote,
  normalizeIdentifier,
  parseContactView,
  shouldCreateContactPage,
} from "./contacts.js";
import { hasPendingReview, newestActivityDate } from "./contactDormancy.js";

/** Where the gateway keeps the lookup's snapshot between runs. Plumbing, rebuildable, never the only copy. */
export const CONTACT_INDEX_KEY = ".context/communications/contacts/identifiers.json";

/** The snapshot format. A snapshot of any other version is ignored, which costs one rebuild. */
export const CONTACT_INDEX_VERSION = 2;

/** How many pages one refresh reads at once. */
const READ_BATCH = 10;

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const IMPORTED_ROLE = /^role:\s*["']?communication-contact["']?\s*$/m;
const IMPORTED_IDENTITY = /^- iMessage:\s*`([^`]+)`\s*$/gm;

/** A page from the earlier iMessage import (`role: communication-contact`, `## Identities`). */
export function isImportedContactNote(text) {
  const frontmatter = FRONTMATTER.exec(String(text ?? ""))?.[1];
  return Boolean(frontmatter && IMPORTED_ROLE.test(frontmatter));
}

/**
 * Who a page says it is: its kind and its identifiers, normalized, or `null`
 * for a page that is neither format — the owner's own note, ciphertext.
 *
 * `contact` is a page this package renders and may merge into; `imported` is
 * found (so it is never duplicated) and never rewritten.
 *
 * @returns {{kind: "contact"|"imported", ids: string[]}|null}
 */
export function contactPageIdentity(text) {
  if (isContactNote(text)) return { kind: "contact", ids: [...identifierSet(parseContactView(text))] };
  if (!isImportedContactNote(text)) return null;
  const ids = [];
  for (const match of String(text).matchAll(IMPORTED_IDENTITY)) {
    const value = match[1].trim();
    const id = normalizeIdentifier({ kind: value.includes("@") ? "email" : "phone", value });
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return { kind: "imported", ids };
}

/**
 * What the lookup remembers of one page: its listed version, kind and
 * identifiers, and — for a page this package renders — its newest activity
 * date (`a`) and whether it waits on a `review:` (`r`), so the dormancy sweep
 * finds candidates without reading every page. `h`, when present, is the day
 * the sweep's move of this page was refused (`holdBack`).
 */
function entryFor(text, version) {
  const identity = text === null ? null : contactPageIdentity(text);
  const contact = identity?.kind === "contact";
  return {
    v: String(version ?? ""),
    k: identity?.kind ?? "other",
    ids: identity?.ids ?? [],
    a: contact ? (newestActivityDate(text) ?? "") : "",
    r: contact ? hasPendingReview(text) : false,
  };
}

/** A remembered day, or `""` for none. */
const SNAPSHOT_DATE = /^(\d{4}-\d{2}-\d{2})?$/;

/** Is this key one the lookup indexes — a live contact page, or one archived at its mirror path? */
function isIndexedPath(path, root) {
  return isContactNotePath(path, { root }) || liveContactPathForArchived(path, { root }) !== null;
}

/** A snapshot's pages, or an empty map for anything that is not one. Never trusted beyond its shape. */
function pagesFromSnapshot(snapshot, root) {
  const pages = new Map();
  if (snapshot?.version !== CONTACT_INDEX_VERSION || typeof snapshot.pages !== "object" || !snapshot.pages) return pages;
  for (const [path, entry] of Object.entries(snapshot.pages)) {
    if (!isIndexedPath(path, root)) continue;
    if (typeof entry?.v !== "string" || !["contact", "imported", "other"].includes(entry.k)) continue;
    if (!Array.isArray(entry.ids) || !entry.ids.every((id) => typeof id === "string")) continue;
    const a = entry.a ?? "";
    const h = entry.h ?? "";
    if (typeof a !== "string" || !SNAPSHOT_DATE.test(a) || typeof h !== "string" || !SNAPSHOT_DATE.test(h)) continue;
    const kept = { v: entry.v, k: entry.k, ids: entry.ids, a, r: entry.r === true };
    pages.set(path, h ? { ...kept, h } : kept);
  }
  return pages;
}

/**
 * The prefixes a lookup lists: the live contacts folder and its archive
 * mirror, each under the plain names written since 2026-10-21 and the
 * numbered ones written before (`0-inbox`, `4-archive`), so a page in a
 * workspace the rename skipped is found where it is and never written twice.
 */
export function contactPrefixes(options = {}) {
  const root = normalizeRoot(options.root);
  const legacy = `${LEGACY_INBOX_FOLDER}${CONTACTS_FOLDER.slice(INBOX_FOLDER.length)}`;
  return [
    `${root}${CONTACTS_FOLDER}/`,
    `${root}${legacy}/`,
    `${root}${CONTACT_ARCHIVE_FOLDER}/${CONTACTS_FOLDER}/`,
    `${root}4-archive/${legacy}/`,
  ];
}

/**
 * One lookup for one sync run.
 *
 * @param {{
 *   list: (prefix: string) => Promise<Array<{key: string, version?: string}>>,
 *   read: (path: string) => Promise<string|null>,
 *   root?: string,
 *   snapshot?: unknown,
 * }} deps `list` lists every key under a prefix (`contactPrefixes`); anything
 *   that is not a page one folder deep is ignored. `version` is the listing's
 *   etag, or anything that changes when a page does — a page without one is
 *   read on every refresh. A listing that fails must throw: a short one would
 *   read as "nobody has a page" and create duplicates.
 */
export function createContactLookup({ list, read, root, snapshot }) {
  const pages = pagesFromSnapshot(snapshot, root);
  let byId = null;
  let refreshed = null;

  function index() {
    byId = new Map();
    for (const [path, entry] of pages) {
      for (const id of entry.ids) byId.set(id, [...(byId.get(id) ?? []), path]);
    }
  }

  async function refresh() {
    const listed = (await Promise.all(contactPrefixes({ root }).map((prefix) => list(prefix))))
      .flat()
      .filter(({ key }) => isIndexedPath(key, root));
    const live = new Set(listed.map(({ key }) => key));
    for (const path of [...pages.keys()]) if (!live.has(path)) pages.delete(path);
    const stale = listed.filter(({ key, version }) => !version || pages.get(key)?.v !== String(version));
    for (let start = 0; start < stale.length; start += READ_BATCH) {
      await Promise.all(stale.slice(start, start + READ_BATCH).map(async ({ key, version }) => {
        const text = await read(key);
        if (text === null) pages.delete(key);
        else pages.set(key, entryFor(text, version));
      }));
    }
    index();
  }

  /**
   * The page carrying any of the draft's identifiers. A live page beats an
   * archived one, a page we render beats an imported one, then by path — so
   * the same bucket always answers the same way.
   */
  async function find(draft) {
    refreshed ??= refresh();
    await refreshed;
    const found = new Set();
    for (const id of identifierSet(draft)) for (const path of byId.get(id) ?? []) found.add(path);
    const rank = (path) =>
      (liveContactPathForArchived(path, { root }) === null ? 0 : 2) + (pages.get(path)?.k === "contact" ? 0 : 1);
    return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? null;
  }

  return {
    find,

    /**
     * Where this draft goes: the page found for it (with `revive`, its live
     * path, when that page is archived), or a new page's path. `null` when
     * there is nowhere it may go — no identifier, somebody nobody has a page
     * for and `shouldCreateContactPage` declines, or a new page's key that is
     * already a page carrying none of them.
     *
     * @returns {Promise<{path: string, found: boolean, revive?: string}|null>}
     */
    async pathFor(draft) {
      const found = await find(draft);
      if (found !== null) {
        const revive = liveContactPathForArchived(found, { root });
        return revive === null ? { path: found, found: true } : { path: found, found: true, revive };
      }
      if (!shouldCreateContactPage(draft)) return null;
      const path = contactPathForDraft(draft, { root });
      if (path === null || pages.has(path)) return null;
      return { path, found: false };
    },

    /**
     * Live pages this package renders whose remembered newest activity is
     * before `cutoff` (`YYYY-MM-DD`), with no pending review, oldest first —
     * skipping a page held back on or after `heldBefore`. Candidates only:
     * the sweep re-reads each one before it moves anything.
     *
     * @returns {Promise<string[]>}
     */
    async dormantPages(cutoff, heldBefore = "") {
      refreshed ??= refresh();
      await refreshed;
      return [...pages]
        .filter(([path, entry]) =>
          entry.k === "contact" && !entry.r && entry.a !== "" && entry.a < cutoff &&
          !(entry.h && entry.h >= heldBefore) &&
          liveContactPathForArchived(path, { root }) === null)
        .sort(([pathA, a], [pathB, b]) => a.a.localeCompare(b.a) || pathA.localeCompare(pathB))
        .map(([path]) => path);
    },

    /** The sweep's move of this page was refused on `day`: skipped for a while, or until the page changes. */
    holdBack(path, day) {
      const entry = pages.get(path);
      if (entry && typeof day === "string" && SNAPSHOT_DATE.test(day)) pages.set(path, { ...entry, h: day });
    },

    /** What a page now holds — after this run wrote or moved it, or found the index wrong. `null` text: gone. */
    record(path, text, version) {
      if (!isIndexedPath(path, root)) return;
      if (text === null) pages.delete(path);
      else pages.set(path, entryFor(text, version));
      if (byId !== null) index();
    },

    /** The lookup as JSON-able data, for the caller to keep and hand back next run. */
    snapshot() {
      return { version: CONTACT_INDEX_VERSION, pages: Object.fromEntries(pages) };
    },
  };
}

/**
 * The page a draft is merged into, read, and checked against the bytes.
 *
 * The lookup is only as fresh as its listing, so a found page is confirmed to
 * still carry one of the draft's identifiers before anything is written to
 * it; when it does not, the entry is corrected and the lookup asked again.
 * Bounded, and `null` after that — the next run sees a fresh listing.
 *
 * @template {{text: string}} Page
 * @param {ReturnType<typeof createContactLookup>} lookup
 * @param {(path: string) => Promise<Page|null>} readPage
 * @returns {Promise<{path: string, page: Page|null, found: boolean, revive?: string}|null>}
 */
export async function locateContactPage(lookup, draft, readPage, maxAttempts = 3) {
  const wanted = identifierSet(draft);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const target = await lookup.pathFor(draft);
    if (target === null) return null;
    const page = await readPage(target.path);
    if (!target.found) return { ...target, page };
    const ids = page === null ? [] : (contactPageIdentity(page.text)?.ids ?? []);
    if (ids.some((id) => wanted.has(id))) return { ...target, page };
    lookup.record(target.path, page === null ? null : page.text);
  }
  return null;
}

/**
 * Find, revive, merge and write one draft — the one routine all three sync
 * writers run, so where a contact goes is decided in exactly one place.
 *
 * `io` is the writer's storage:
 *  - `read(path)` → `{text, etag}` or `null`;
 *  - `write(path, text, etag|null)` → `{ok: true, version?}` on success,
 *    `{ok: false, conflict: true}` to re-read and retry, or
 *    `{ok: false, stop?, message?}` to give up with that answer (quota, refusal);
 *  - `move(from, to, etag)` → `{ok: boolean, retryable?, message?}`, the writer's ordinary
 *    note move, so links into the page follow it out of the archive.
 *
 * @returns {Promise<{status: "written"|"unchanged"|"error", path?: string,
 *   text?: string, message?: string, stop?: unknown}>}
 */
export async function upsertContactDraft(lookup, draft, io, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const located = await locateContactPage(lookup, draft, io.read);
    if (located === null) return { status: "unchanged" };
    let { path, page } = located;
    if (located.revive) {
      // Only a page this package renders comes back on its own; the owner's
      // imported or hand-written page in the archive stays where they put it.
      if (page === null || !isContactNote(page.text)) return { status: "unchanged" };
      const moved = await io.move(path, located.revive, page.etag);
      // A refusal (the live path is taken, the move was declined) leaves the
      // page archived and the sync moving; only a retryable failure holds it.
      if (!moved.ok) {
        return moved.retryable
          ? { status: "error", message: moved.message ?? "an archived contact could not be moved back" }
          : { status: "unchanged" };
      }
      lookup.record(path, null);
      path = located.revive;
      page = await io.read(path);
      lookup.record(path, page === null ? null : page.text);
      if (page === null) continue;
    }
    const update = mergeContactNote(page === null ? "" : page.text, draft, { path, root: options.root });
    if (update === null) return { status: "unchanged" };
    if (page !== null && page.text === update.text) return { status: "unchanged" };
    const result = await io.write(path, update.text, page === null ? null : page.etag);
    if (result.ok) {
      lookup.record(path, update.text, result.version);
      return { status: "written", path, text: update.text };
    }
    if (!result.conflict) return { status: "error", stop: result.stop, message: result.message };
  }
  return { status: "error", message: "contact did not settle after the bounded retry" };
}
