/**
 * The sync manifest: every visible key and its version, for an offline mirror.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { type Visibility, canSee, visibilityOf } from "../privacy";
import { type Clearance } from "../clearance";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import { requirePath, parentOf } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope, describeFile } from "./listing";

/* -------------------------------------------------------------------------- */
/*                              the sync manifest                             */
/* -------------------------------------------------------------------------- */

/**
 * Manifest entries one call may return. Around 220 bytes of JSON each, so a
 * page stays near two megabytes — well inside what an action may return — and
 * a context of a few thousand notes arrives in one round trip.
 */
export const MANIFEST_PAGE_ENTRIES = 10_000;

/**
 * One object the caller may see, as the offline mirror needs it.
 *
 * The visibility fields are `describeFile`'s, so a tree drawn from the mirror
 * marks exactly the rows a live listing would. `etag` is the store's own,
 * taken from the listing — the same value `readFile` would return — and is
 * absent only where the store listed an object without one, which means
 * "read it to learn its version", never "unchanged".
 */
export interface ManifestEntry {
  path: string;
  etag?: string;
  size?: number;
  updatedAt?: number;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
}

/**
 * One folder the caller may see, with its own default — the row `listFolder`
 * would draw for it, and the `folderDefault` a listing of it would carry.
 */
export interface ManifestFolder {
  path: string;
  visibility: Visibility;
}

export interface SyncManifest {
  /** In the store's key order. */
  entries: ManifestEntry[];
  /**
   * Every folder this page's keys live under that `listFolder` would draw for
   * this caller, the root (`""`) first, so a client can draw the whole tree
   * from the manifest and open a folder without asking for it.
   *
   * Derived from **every** key the page walked, hidden ones included, and kept
   * by exactly `listFolder`'s test (`folderVisibleAtScope`) — so it names a
   * folder whose visible notes are all further down, and an empty folder a
   * tool made with a marker key, and it names no folder a listing would not.
   * A folder can appear on more than one page; the client unions them.
   */
  folders: ManifestFolder[];
  /**
   * Call again with this to get what follows; `null` when nothing does.
   *
   * It is always the path of the last entry this page returned — never the
   * store's continuation token. See `syncManifest`.
   */
  cursor: string | null;
  /**
   * The walk stopped and cannot continue, so the pages so far are a floor, not
   * a total. A mirror must not read a missing path as deleted while this is
   * true. Implies `cursor === null`.
   */
  truncated: boolean;
  /** `privacy.md` is missing or unparseable. Same meaning as a listing's. */
  manifestUsable: boolean;
}

/** S3 lists in UTF-8 byte order, which is not JavaScript's string order. */
const KEY_BYTES = new TextEncoder();
function compareKeys(a: string, b: string): number {
  const x = KEY_BYTES.encode(a);
  const y = KEY_BYTES.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let index = 0; index < shared; index += 1) {
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  }
  return x.length - y.length;
}


/**
 * Every object in the bucket this caller may see, with its version — what the
 * offline mirror is built from.
 *
 * **One filter, and it is `canSee`.** The same call `listFolder` and
 * `readFile` make, with the same clearance, so there is no second privacy path
 * to drift: a `team` reader never receives a private note's path, etag or
 * size, `privacy.md` reaches only `private` scope, and Context's plumbing
 * (`.context/`, `.history/`, `.audit/`, `.obsidian/`) reaches nobody.
 *
 * **No note is read.** The etag is the listing's — S3's `ETag`, Dropbox's
 * `rev` — which is the value a read returns, so a sync can tell which notes
 * changed from one walk and fetch only those.
 *
 * ## Why the cursor is a path the caller was given
 *
 * A bucket can hold more than one response's worth, so this pages. The
 * obvious cursor is the store's continuation token, and it is a leak: on S3 it
 * is base64 of the last *backend* key of the page, and at `team` scope that key
 * is routinely a private note. So the cursor is the last path this page
 * returned — something the caller already holds — and resuming asks the store
 * for what comes after it (`startAfter`, ListObjectsV2's `start-after`).
 *
 * That only means something on a store that lists in key order and honours the
 * position, and not every store does: Dropbox's recursive `list_folder` does
 * neither. So both are checked rather than assumed. A listing seen out of
 * order gets no cursor, and a resumed walk that comes back with a key at or
 * before the cursor stops — in both cases `truncated`, because handing back
 * the start of the bucket under a cursor that promised the rest would loop the
 * client forever. A page that can make no progress (a run of more hidden keys
 * than the page budget) ends the same way, for the same reason.
 */
export async function syncManifest(
  store: FileStore,
  options: { clearance: Clearance; cursor?: string; pageEntries?: number },
): Promise<SyncManifest> {
  const after = options.cursor === undefined ? undefined : requirePath(options.cursor);
  const pageEntries = options.pageEntries ?? MANIFEST_PAGE_ENTRIES;
  const state = await loadPrivacyState(store);
  const manifestUsable = state.text !== null && !state.invalid;
  const short = (): SyncManifest => ({
    entries: [],
    folders: [],
    cursor: null,
    truncated: true,
    manifestUsable,
  });

  const entries: ManifestEntry[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let ordered = true;
  let previous: string | undefined;
  let token: string | undefined;

  /*
    The folders, by `listFolder`'s own test and nothing else. A folder is
    asked about once however many keys live under it, and the walk up stops at
    the first ancestor already asked about, because that one's ancestors were
    asked about with it. The root is always drawn, so it is always here.
  */
  const folders: ManifestFolder[] = [{ path: "", visibility: visibilityOf("", state.rules) }];
  const askedFolders = new Set<string>([""]);
  const noteFolders = (key: string) => {
    let at = key.endsWith("/") ? key.replace(/\/+$/, "") : parentOf(key);
    while (at !== "" && !askedFolders.has(at)) {
      askedFolders.add(at);
      if (folderVisibleAtScope(at, options.clearance, state.rules, state.overrides)) {
        folders.push({ path: at, visibility: visibilityOf(at, state.rules) });
      }
      at = parentOf(at);
    }
  };

  /** Stop here, with a cursor only where one can be honoured and moves on. */
  const stop = (): SyncManifest => {
    if (!ordered || entries.length === 0) {
      return { ...short(), entries, folders };
    }
    return {
      entries,
      folders,
      cursor: entries[entries.length - 1]!.path,
      truncated: false,
      manifestUsable,
    };
  };

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({
      prefix: "",
      limit: 1000,
      ...(token !== undefined ? { cursor: token } : after !== undefined ? { startAfter: after } : {}),
    });

    for (const object of listing.objects ?? []) {
      const key = object.key;
      // The store went back to the start rather than resuming. Nothing it says
      // from here is "the rest", and `entries` may be a replay.
      if (after !== undefined && compareKeys(key, after) <= 0) return short();
      if (previous !== undefined && compareKeys(key, previous) <= 0) ordered = false;
      previous = key;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      noteFolders(key);
      if (!canSee(key, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) continue;

      const meta = object as { size?: number; uploaded?: Date | string | number; etag?: string };
      const described = describeFile(key, state.rules, state.overrides);
      entries.push({
        path: key,
        ...(typeof meta.etag === "string" && meta.etag !== "" ? { etag: meta.etag } : {}),
        ...(typeof meta.size === "number" ? { size: meta.size } : {}),
        ...(meta.uploaded === undefined ? {} : { updatedAt: new Date(meta.uploaded).getTime() }),
        visibility: described.visibility,
        inherited: described.inherited,
        exception: described.exception,
        readOnly: described.readOnly,
      });
      if (entries.length >= pageEntries) return stop();
    }

    if (!listing.truncated) {
      return { entries, folders, cursor: null, truncated: false, manifestUsable };
    }
    // Truncated with nowhere to go, or a cursor seen before: the store cannot
    // finish this walk. See `listFolder` and `keysUnder` for the shapes.
    if (!listing.cursor || seenCursors.has(listing.cursor)) {
      return { ...short(), entries, folders };
    }
    seenCursors.add(listing.cursor);
    token = listing.cursor;
  }
  // The page budget ran out mid-bucket. Resumable from the last path returned
  // where there is one; otherwise this call learned nothing it can hand on.
  return stop();
}
