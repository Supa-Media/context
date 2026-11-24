/**
 * A folder page's reads, kept for the tab across a reload.
 *
 * Owner, 2026-11-24, of the Areas page after a reload: "it takes like 3
 * seconds to load". A reload empties `pageCache`, so the page waited on the
 * server for its notes while the file tree beside it was already drawn from
 * this tab's copy (`offline/serverTree.ts`). The same rule as that copy holds
 * here: kept in `sessionStorage` only, so it dies with the tab, cleared at
 * sign-out and when a workspace is left (`forgetPageCache`), keyed by
 * clearance as well as workspace, and never `localStorage`, whose quota the
 * queue of unsent edits depends on. What is kept is what a folder page draws
 * (front matter, first heading and paragraph, a metric's latest readings),
 * never a note's whole text. A page drawn from it reads again behind it.
 *
 * One entry per source, each section written a moment after it changes, and
 * bounded: a page over `MAX_BYTES` is simply not kept.
 */

const PREFIX = "context.lc.pages.v1:";
/** Of `sessionStorage`'s five or so megabytes, the file tree's copy needs most. */
const MAX_BYTES = 1_000_000;
const WRITE_AFTER_MS = 400;

type Sections = Record<string, unknown>;

const loaded = new Map<string, Sections>();
const writing = new Map<string, ReturnType<typeof setTimeout>>();

function sessionStore(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    // A browser blocking site data throws on the property itself.
    return null;
  }
}

function sectionsOf(key: string): Sections {
  let found = loaded.get(key);
  if (found !== undefined) return found;
  found = {};
  const storage = sessionStore();
  if (storage !== null) {
    try {
      const raw = storage.getItem(PREFIX + key);
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) found = parsed as Sections;
    } catch {
      // Unreadable: start empty, as a new tab does.
    }
  }
  loaded.set(key, found);
  return found;
}

/** What this tab kept of one section for `key`, or undefined. */
export function keptSection<T>(key: string, section: string): T | undefined {
  return sectionsOf(key)[section] as T | undefined;
}

/** Keep one section for `key`; written to the tab a moment later, with any other change. Best effort. */
export function keepSection(key: string, section: string, value: unknown): void {
  sectionsOf(key)[section] = value;
  if (writing.has(key)) return;
  writing.set(
    key,
    setTimeout(() => {
      writing.delete(key);
      const storage = sessionStore();
      if (storage === null) return;
      try {
        const text = JSON.stringify(loaded.get(key) ?? {});
        if (text.length > MAX_BYTES) storage.removeItem(PREFIX + key);
        else storage.setItem(PREFIX + key, text);
      } catch {
        // Full or blocked: the next reload reads from the server, as before.
        try {
          storage.removeItem(PREFIX + key);
        } catch {
          // Nothing more to do.
        }
      }
    }, WRITE_AFTER_MS),
  );
}

/** Forget every page this tab kept: at sign-out and when a workspace is left. */
export function forgetTabPages(): void {
  for (const timer of writing.values()) clearTimeout(timer);
  writing.clear();
  loaded.clear();
  const storage = sessionStore();
  if (storage === null) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      if (name !== null && name.startsWith(PREFIX)) keys.push(name);
    }
    for (const name of keys) storage.removeItem(name);
  } catch {
    // Blocked storage held nothing to forget.
  }
}
