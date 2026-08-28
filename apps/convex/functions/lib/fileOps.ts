/**
 * File operations against a customer's bucket.
 *
 * Everything the console's editor can do — list, read, write, create, move,
 * duplicate, copy, archive, delete, change visibility — expressed against a
 * `ContextStore` and nothing else. No Convex, no credential, no database.
 *
 * ## Why that separation is the point
 *
 * The credential is opened in exactly one place (`functions/files.ts`'s
 * `runFileOperation`), and this module is what it hands the resulting store to.
 * So every rule below — who may see what, what a stale etag does, whether a
 * delete is recoverable — is testable against an in-memory bucket with no
 * decryption, no auth, and no fixtures, and the security-critical module above
 * stays small enough to read in one sitting.
 *
 * ## The three rules that are not negotiable
 *
 *  1. **Note content passes through; it is never persisted here or above.**
 *     Nothing in this file writes to a database, and no error it throws
 *     interpolates a note body. Paths are metadata and may appear; content may
 *     not. `__tests__/fileContent.test.ts` asserts this behaviourally over
 *     every operation.
 *
 *  2. **A caller who may not see a note gets the same answer as for a note
 *     that does not exist.** `FILE_NOT_FOUND`, identical payload, identical
 *     wording. Anything else is an existence oracle: a team-scoped colleague
 *     could enumerate the names of your private notes by watching which paths
 *     answer "forbidden" instead of "missing".
 *
 *  3. **`privacy.md` is generated, never typed into.** It is the access map,
 *     and hand-editing it through a UI that also *writes* it is how a person
 *     loses every rule they had. `setVisibility` / `setFolderVisibility` are
 *     the only way to change a rule, and a write to that key through
 *     `writeFile` is refused.
 *
 *     `resetPrivacyManifest` is the one other function that puts to that key,
 *     and it is not an exception to the rule so much as the floor beneath it:
 *     it takes no content, replaces only a manifest that does not parse, and
 *     writes every folder `private`. There is no argument to it by which a note
 *     could change hands.
 */

import {
  PRIVACY_KEY,
  type PrivacyRule,
  type Scope,
  type Visibility,
  canSee,
  clearedOverrides,
  effectiveVisibility,
  isPlumbing,
  movedOverrides,
  nextOverrides,
  parsePrivacyManifest,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "./privacy";
import { renderPrivacyManifestForFolders, type ScaffoldStore } from "./scaffold";

/* -------------------------------------------------------------------------- */
/*                                   limits                                   */
/* -------------------------------------------------------------------------- */

/** S3 caps keys at 1024; the gateway's `normalizePath` caps paths at 512. */
const MAX_PATH_LENGTH = 512;
/** One note. Generous for markdown, small enough that a paste cannot DoS an action. */
export const MAX_NOTE_BYTES = 2_000_000;
/** Pages of a listing we will walk. 1000 keys each. */
const LIST_PAGE_CAP = 20;
/** Keys a single folder move/copy/delete may touch. Same cap the gateway uses. */
export const FOLDER_OPERATION_CAP = 500;
/** Attempts at the compare-and-swap that rewrites `privacy.md`. */
const MANIFEST_CAS_ATTEMPTS = 5;

const HISTORY_PREFIX = ".history/";
const ARCHIVE_ROOT = "4-archive";

/* -------------------------------------------------------------------------- */
/*                                   store                                    */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `ContextStore` these operations use.
 *
 * `ScaffoldStore` already declares `get`/`put`/`list` structurally (the adapter
 * is JSDoc-typed JavaScript whose typedefs are not importable bindings); this
 * adds the `delete` and the capability descriptor. The real `S3Store` satisfies
 * it by construction, and the tests run the real adapter against a wire-level
 * stub.
 */
export interface FileStore extends ScaffoldStore {
  delete(key: string): Promise<void>;
  capabilities?: { conditionalWrite: boolean };
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                   */
/* -------------------------------------------------------------------------- */

export type FileErrorCode =
  /** Missing, or invisible at the caller's scope. Deliberately the same code. */
  | "FILE_NOT_FOUND"
  | "PATH_INVALID"
  | "DESTINATION_EXISTS"
  | "CONFLICT"
  | "PRIVACY_MANIFEST_READ_ONLY"
  | "PRIVACY_MANIFEST_MISSING"
  | "PRIVACY_MANIFEST_INVALID"
  /** A reset was asked for on a manifest that parses. Refused, not a no-op. */
  | "PRIVACY_MANIFEST_USABLE"
  | "PRIVACY_MANIFEST_BUSY"
  | "CONTENT_TOO_LARGE"
  | "FOLDER_TOO_LARGE"
  | "CONFIRMATION_REQUIRED"
  | "NOT_A_FOLDER";

/**
 * A failure with a code the console can branch on and a message a person can
 * act on.
 *
 * `message` may name a **path**; it may never carry note content, a
 * credential, or a provider's raw response. Rule 1 at the top of this file.
 */
export class FileOpError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
    /** Only ever an etag or a path — never content. */
    readonly currentEtag?: string,
  ) {
    super(message);
    this.name = "FileOpError";
  }
}

/**
 * The one error used for "you cannot have this".
 *
 * Built in a single place so no future operation can leak the difference
 * between "not yours to see" and "never existed" by phrasing its own message
 * slightly differently — the same discipline `lib/workspaceAuth.ts` applies to
 * `WORKSPACE_NOT_FOUND`, for the same reason.
 */
function notFound(): FileOpError {
  return new FileOpError("FILE_NOT_FOUND", "That file does not exist.");
}

/* -------------------------------------------------------------------------- */
/*                                    paths                                   */
/* -------------------------------------------------------------------------- */

/**
 * Clean a caller-supplied path, or `null` if it is not addressable.
 *
 * Mirrors the gateway's `normalizePath`: a trailing slash is stripped rather
 * than rejected (naming a folder `1-projects/` is natural), and `..` is
 * refused outright rather than resolved. The storage adapter refuses these
 * again at its own boundary; two independent checks is deliberate.
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== "string") return null;
  const clean = input
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!clean || clean.length > MAX_PATH_LENGTH) return null;
  if (clean.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return clean;
}

function requirePath(input: string): string {
  const path = normalizePath(input);
  if (path === null) throw new FileOpError("PATH_INVALID", "That path is not valid.");
  return path;
}

/** The empty string is the bucket root, which normalizePath cannot express. */
function requireFolderPath(input: string): string {
  const trimmed = input.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (trimmed === "") return "";
  return requirePath(trimmed);
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** `2026-08-26T09-14-02-113Z`. Same shape the gateway stamps history with. */
export function timestampSlug(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

/* -------------------------------------------------------------------------- */
/*                              the privacy state                             */
/* -------------------------------------------------------------------------- */

interface PrivacyState {
  rules: PrivacyRule[];
  overrides: Map<string, Visibility>;
  /** The manifest's full text, when there is a parseable one to rewrite. */
  text: string | null;
  etag: string | null;
  /** Set when a manifest exists but does not parse. */
  invalid: boolean;
}

/**
 * Read `privacy.md`.
 *
 * Three outcomes, and the fallbacks are chosen to fail *closed*:
 *  - parsed → its rules apply.
 *  - absent (a legacy `scopes.yml` bucket, or one we never scaffolded) → no
 *    rules, which means everything is private.
 *  - present but unparseable → no rules, same as absent. The gateway degrades
 *    the same way, and the alternative — guessing at half a file — is how a
 *    note the owner marked private becomes team-readable.
 */
export async function loadPrivacyState(store: FileStore): Promise<PrivacyState> {
  const object = await store.get(PRIVACY_KEY);
  if (object === null) {
    return { rules: [], overrides: new Map(), text: null, etag: null, invalid: false };
  }
  const text = await object.text();
  try {
    const parsed = parsePrivacyManifest(text);
    return {
      rules: parsed.rules,
      overrides: parsed.overrides,
      text,
      etag: object.etag,
      invalid: false,
    };
  } catch {
    // The message is deliberately dropped: it echoes the offending line of the
    // customer's file, and a manifest line can name a private folder.
    return { rules: [], overrides: new Map(), text, etag: object.etag, invalid: true };
  }
}

/* -------------------------------------------------------------------------- */
/*                                  listing                                   */
/* -------------------------------------------------------------------------- */

export interface FileEntry {
  kind: "file" | "folder";
  path: string;
  name: string;
  /** What a client at `team` scope would be allowed to see. */
  visibility: Visibility;
  /** The folder default this path inherits, ignoring any exact-note exception. */
  inherited: Visibility;
  /**
   * `visibility !== inherited`. The console marks **only these** — labelling
   * every note in a private folder "private" is noise, and hides the one that
   * is not.
   */
  exception: boolean;
  /** `privacy.md`: shown, explained, never typed into. */
  readOnly: boolean;
  size?: number;
  updatedAt?: number;
}

export interface FolderListing {
  path: string;
  /** The folder's own default. This is what the folder row displays. */
  folderDefault: Visibility;
  entries: FileEntry[];
  /** True when the listing stopped at the page cap rather than the end. */
  truncated: boolean;
  /** `privacy.md` is missing or unparseable, so nothing can be shared yet. */
  manifestUsable: boolean;
}

/**
 * Is a *folder* worth showing to a caller at this scope?
 *
 * A folder is not a note and has no visibility of its own beyond its default,
 * but a private folder can still contain a note with a `team` exception — and
 * hiding the folder would make that note unreachable in the tree. The
 * exception map is the complete list of ways that can happen, and it comes
 * from the manifest we already parsed, so this is exact and costs no listing.
 */
function folderVisibleAtScope(
  folderPath: string,
  scope: Scope,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): boolean {
  if (isPlumbing(folderPath)) return false;
  if (scope === "private") return true;
  if (visibilityOf(folderPath, rules) === "team") return true;
  for (const [path, visibility] of overrides) {
    if (visibility === "team" && path.startsWith(`${folderPath}/`)) return true;
  }
  return false;
}

function describeFile(
  key: string,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
  extra: { size?: number; updatedAt?: number } = {},
): FileEntry {
  const inherited = visibilityOf(key, rules);
  const visibility = effectiveVisibility(key, rules, overrides);
  return {
    kind: "file",
    path: key,
    name: baseName(key),
    visibility,
    inherited,
    exception: visibility !== inherited,
    readOnly: key === PRIVACY_KEY,
    ...extra,
  };
}

/** One folder's immediate children, as the tree renders them. */
export async function listFolder(
  store: FileStore,
  options: { path: string; scope: Scope },
): Promise<FolderListing> {
  const folder = requireFolderPath(options.path);
  const state = await loadPrivacyState(store);

  if (folder !== "" && !folderVisibleAtScope(folder, options.scope, state.rules, state.overrides)) {
    throw notFound();
  }

  const prefix = folder === "" ? "" : `${folder}/`;
  const entries: FileEntry[] = [];
  const seenFolders = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, delimiter: "/", cursor, limit: 1000 });

    for (const object of listing.objects ?? []) {
      const key = object.key;
      if (key === prefix) continue; // a zero-byte folder marker, if a tool made one
      if (!canSee(key, options.scope, state.rules, state.overrides)) continue;
      const meta = object as { size?: number; uploaded?: Date | string | number };
      entries.push(
        describeFile(key, state.rules, state.overrides, {
          size: typeof meta.size === "number" ? meta.size : undefined,
          updatedAt:
            meta.uploaded === undefined ? undefined : new Date(meta.uploaded).getTime(),
        }),
      );
    }

    for (const raw of listing.delimitedPrefixes ?? []) {
      const child = raw.replace(/\/+$/, "");
      if (!child || seenFolders.has(child)) continue;
      if (!folderVisibleAtScope(child, options.scope, state.rules, state.overrides)) continue;
      seenFolders.add(child);
      const inherited = visibilityOf(child, state.rules);
      entries.push({
        kind: "folder",
        path: child,
        name: baseName(child),
        visibility: inherited,
        inherited,
        exception: false,
        readOnly: false,
      });
    }

    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
    if (page === LIST_PAGE_CAP - 1) truncated = true;
  }

  entries.sort(compareEntries);

  return {
    path: folder,
    folderDefault: folder === "" ? visibilityOf("", state.rules) : visibilityOf(folder, state.rules),
    entries,
    truncated,
    manifestUsable: state.text !== null && !state.invalid,
  };
}

/** Folders first, then files, each alphabetically — the order Obsidian uses. */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/* -------------------------------------------------------------------------- */
/*                                   reading                                  */
/* -------------------------------------------------------------------------- */

export interface FileContents {
  path: string;
  text: string;
  etag: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  /** `privacy.md`. The console shows it with an explanation instead of a textarea. */
  readOnly: boolean;
}

export async function readFile(
  store: FileStore,
  options: { path: string; scope: Scope },
): Promise<FileContents> {
  const path = requirePath(options.path);
  const state = await loadPrivacyState(store);
  if (!canSee(path, options.scope, state.rules, state.overrides)) throw notFound();

  const object = await store.get(path);
  if (object === null) throw notFound();

  const described = describeFile(path, state.rules, state.overrides);
  return {
    path,
    text: await object.text(),
    etag: object.etag,
    visibility: described.visibility,
    inherited: described.inherited,
    exception: described.exception,
    readOnly: described.readOnly,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   writing                                  */
/* -------------------------------------------------------------------------- */

export interface WriteResult {
  path: string;
  etag: string;
  /**
   * How the conflict check was performed.
   *
   * `conditional` — the backend enforced `If-Match`, so a concurrent write
   * could not have landed between the check and ours.
   * `read-compare` — the backend does not enforce it (B2, Wasabi), so we read
   * the etag and compared it ourselves. That is a real check with a real race
   * window, and the console says so rather than implying a guarantee we do not
   * have. Never silently downgraded to no check at all.
   */
  conflictCheck: "conditional" | "read-compare";
}

/**
 * Save a note.
 *
 * `expectedEtag` is the etag the editor read. A mismatch is a **conflict**,
 * surfaced with the current etag so the console can say "this changed
 * elsewhere" and offer to reload — never a silent overwrite.
 *
 * Omitting `expectedEtag` means "this is new": if the key already exists that
 * is also a conflict, not an overwrite. There is no way to say "clobber
 * whatever is there", by design.
 */
export async function writeFile(
  store: FileStore,
  options: {
    path: string;
    text: string;
    expectedEtag?: string;
    scope: Scope;
    now: number;
  },
): Promise<WriteResult> {
  const path = requirePath(options.path);
  assertWritablePath(path);
  if (byteLength(options.text) > MAX_NOTE_BYTES) {
    throw new FileOpError(
      "CONTENT_TOO_LARGE",
      `A note must be at most ${MAX_NOTE_BYTES} bytes.`,
    );
  }

  const state = await loadPrivacyState(store);
  // Creating a note somewhere a team caller cannot see means creating a note
  // they immediately could not read. Refuse with the same not-found as a note
  // that is not theirs, so the folder's default is not an oracle either.
  if (!canSee(path, options.scope, state.rules, state.overrides)) throw notFound();

  const existing = await store.get(path);

  if (options.expectedEtag === undefined) {
    if (existing !== null) {
      throw new FileOpError(
        "CONFLICT",
        "A file already exists at that path. Reload to see it.",
        existing.etag,
      );
    }
  } else if (existing === null) {
    throw new FileOpError(
      "CONFLICT",
      "That file was deleted somewhere else while you were editing it.",
    );
  } else if (existing.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      existing.etag,
    );
  }

  // Keep the version we are about to replace. Same `.history/` convention the
  // gateway writes, so a rollback looks the same whoever made the edit.
  if (existing !== null) {
    await store.put(
      `${HISTORY_PREFIX}${path}.${timestampSlug(options.now)}.md`,
      await existing.text(),
    );
  }

  const conditional = store.capabilities?.conditionalWrite === true && existing !== null;
  const put = conditional
    ? await store.put(path, options.text, { onlyIf: { etagMatches: existing!.etag } })
    : await store.put(path, options.text);

  if (put === null) {
    // The backend rejected the precondition: somebody wrote between our read
    // and our put. Exactly the case conditional writes exist for.
    const current = await store.get(path);
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      current?.etag,
    );
  }

  return {
    path,
    etag: put.etag,
    conflictCheck: conditional ? "conditional" : "read-compare",
  };
}

/** Refuse the paths that are not notes, before anything else happens. */
function assertWritablePath(path: string): void {
  if (path === PRIVACY_KEY) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_READ_ONLY",
      "privacy.md is generated from your visibility settings. Change a file or folder's visibility instead of editing it.",
    );
  }
  if (isPlumbing(path)) {
    throw new FileOpError(
      "PATH_INVALID",
      "Paths beginning with a dot are reserved for history and audit.",
    );
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/* -------------------------------------------------------------------------- */
/*                             creating and copying                           */
/* -------------------------------------------------------------------------- */

/**
 * Create a folder.
 *
 * S3 has no folders — a folder is a shared key prefix — so an "empty folder"
 * can only exist in a UI's memory unless something is written. Rather than
 * invent a hidden marker object (a dot-prefixed key is plumbing and would be
 * invisible to the very tools this is for), a new folder gets a `README.md`,
 * exactly as the PARA scaffold does. The folder is then real for Obsidian,
 * rclone, the gateway and everything else that reads the bucket.
 */
export async function createFolder(
  store: FileStore,
  options: { path: string; scope: Scope; now: number },
): Promise<{ path: string; readme: string }> {
  const folder = requirePath(options.path);
  if (isPlumbing(folder)) {
    throw new FileOpError(
      "PATH_INVALID",
      "Paths beginning with a dot are reserved for history and audit.",
    );
  }
  const readme = joinPath(folder, "README.md");
  const existing = await store.get(readme);
  if (existing !== null) {
    throw new FileOpError("DESTINATION_EXISTS", "That folder already exists.");
  }
  await writeFile(store, {
    path: readme,
    text: `# ${baseName(folder)}\n`,
    scope: options.scope,
    now: options.now,
  });
  return { path: folder, readme };
}

/**
 * "foo.md" → "foo copy.md" → "foo copy 2.md".
 *
 * Obsidian's convention, and the reason it is a pure function is that picking
 * a free name is the fiddly half of duplicating and deserves its own tests.
 */
export function duplicateName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = `${stem} copy${extension}`;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${stem} copy ${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}

/** Every key under a folder, capped. Used by move, copy and delete. */
async function keysUnder(store: FileStore, folder: string): Promise<string[]> {
  const prefix = `${folder}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (isPlumbing(object.key)) continue;
      keys.push(object.key);
      if (keys.length > FOLDER_OPERATION_CAP) {
        throw new FileOpError(
          "FOLDER_TOO_LARGE",
          `That folder holds more than ${FOLDER_OPERATION_CAP} files. Move or delete it in smaller pieces.`,
        );
      }
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return keys;
}

/**
 * Every `.history/` key holding an earlier version of this path.
 *
 * `keysUnder` deliberately skips plumbing, and `.history/` is plumbing — which
 * is right for move and copy, and was wrong for delete. This is the one caller
 * that has to look inside it.
 *
 * **Matched by prefix, not by parsing the stamp.** Snapshots are written as
 * `.history/<path>.<stamp>.md` with an optional kind in the middle, and there
 * are five spellings of that across two apps already (`.md`, `.move.md`,
 * `.archive.md`, `.batch-move.md`, `.inbox.md`) written by four different
 * functions. A regex that had to stay in sync with all of them would fail
 * *silently and in the wrong direction*: an unrecognised key is a copy left
 * behind under a sentence promising none. `.history/<path>.` is the one thing
 * every writer agrees on, so that is what this matches, and the only thing it
 * can over-match is another note's — equally unreachable — plumbing, which
 * would need a note literally named `<this note>.something.md`.
 *
 * No `FOLDER_OPERATION_CAP`. That cap exists to stop someone moving a folder
 * bigger than an action can carry, and refusing is a safe answer there: nothing
 * has happened yet. Refusing to finish a *purge* is not safe in the same way —
 * it would leave exactly the hidden copy this function exists to remove. The
 * listing is still bounded by `LIST_PAGE_CAP` pages.
 */
async function historyKeysFor(
  store: FileStore,
  path: string,
  pathIsFolder: boolean,
): Promise<string[]> {
  // A folder's history mirrors its shape (`.history/1-projects/note.md.<stamp>.md`),
  // so the whole subtree goes. A file's history is the siblings sharing its name.
  const prefix = pathIsFolder ? `${HISTORY_PREFIX}${path}/` : `${HISTORY_PREFIX}${path}.`;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      // For a file, a `/` in the tail would mean a directory we did not put
      // there — leave it rather than sweep something we cannot explain.
      if (pathIsFolder || !object.key.slice(prefix.length).includes("/")) {
        keys.push(object.key);
      }
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return keys;
}

/** Does this path name a folder (something has keys under it)? */
async function isFolder(store: FileStore, path: string): Promise<boolean> {
  const listing = await store.list({ prefix: `${path}/`, limit: 1 });
  return (listing.objects ?? []).length > 0 || (listing.delimitedPrefixes ?? []).length > 0;
}

export interface MoveResult {
  from: string;
  to: string;
  /** Every key that moved. Paths, which are metadata — never content. */
  paths: string[];
}

/**
 * Move or rename. A rename is a move whose parent does not change, so there is
 * one implementation rather than two that can disagree.
 *
 * Works on a file or a whole folder. The destination must not exist: this
 * never merges and never overwrites.
 *
 * The privacy manifest moves with it. That is the part it would be easy to
 * skip and expensive to get wrong — without it, dragging a private note into a
 * `team` folder silently shares it, because the exception that kept it private
 * still names a path that no longer exists.
 */
export async function movePath(
  store: FileStore,
  options: { from: string; to: string; scope: Scope; now: number },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(from);
  assertWritablePath(to);
  if (from === to) return { from, to, paths: [] };
  if (to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be moved inside itself.");
  }

  const state = await loadPrivacyState(store);
  if (!canSee(from, options.scope, state.rules, state.overrides)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  const sources = sourceIsFolder ? await keysUnder(store, from) : [from];
  if (!sourceIsFolder && (await store.get(from)) === null) throw notFound();
  if (sources.length === 0) throw notFound();

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `Something already exists at ${pair.destination}.`,
      );
    }
  }

  const stamp = timestampSlug(options.now);
  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) continue; // vanished mid-move; nothing to carry
    const body = await object.text();
    await store.put(`${HISTORY_PREFIX}${pair.source}.${stamp}.move.md`, body);
    await store.put(pair.destination, body);
    await store.delete(pair.source);
  }

  await remapPrivacy(store, {
    moves: pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
    folderMove: sourceIsFolder ? { from, to } : null,
  });

  return { from, to, paths: pairs.map((pair) => pair.destination) };
}

/**
 * Copy a file or folder to an explicit destination — the "paste" half of
 * copy/paste.
 *
 * The exception travels with the copy: two files with identical content should
 * not have different visibility because one of them was pasted.
 */
export async function copyPath(
  store: FileStore,
  options: { from: string; to: string; scope: Scope },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(to);
  if (to === from || to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be copied inside itself.");
  }

  const state = await loadPrivacyState(store);
  if (!canSee(from, options.scope, state.rules, state.overrides)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  const sources = sourceIsFolder ? await keysUnder(store, from) : [from];
  if (sources.length === 0) throw notFound();

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `Something already exists at ${pair.destination}.`,
      );
    }
  }

  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) throw notFound();
    await store.put(pair.destination, await object.text());
  }

  await copyPrivacy(
    store,
    pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
  );

  return { from, to, paths: pairs.map((pair) => pair.destination) };
}

/** Copy beside itself under a free "… copy" name. */
export async function duplicatePath(
  store: FileStore,
  options: { path: string; scope: Scope },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  const parent = parentOf(path);
  const siblings = await listFolder(store, { path: parent, scope: options.scope });
  const taken = new Set(siblings.entries.map((entry) => entry.name));
  const destination = joinPath(parent, duplicateName(baseName(path), taken));
  return await copyPath(store, { from: path, to: destination, scope: options.scope });
}

/* -------------------------------------------------------------------------- */
/*                            archiving and deleting                          */
/* -------------------------------------------------------------------------- */

/**
 * Archive: move into `4-archive/<timestamp>/<original path>`.
 *
 * This is the destructive-looking action people should reach for, and it is
 * **not destructive** — the file is intact, its original path is preserved
 * inside the archive path, and moving it back restores it exactly. The
 * timestamp segment means archiving the same note twice never collides.
 *
 * Same destination shape the gateway's `archive_note` uses, so a note archived
 * by Claude and a note archived from the console land in the same place.
 */
export async function archivePath(
  store: FileStore,
  options: { path: string; scope: Scope; now: number },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  if (path === ARCHIVE_ROOT || path.startsWith(`${ARCHIVE_ROOT}/`)) {
    throw new FileOpError("PATH_INVALID", "That is already in the archive.");
  }
  const destination = `${ARCHIVE_ROOT}/${timestampSlug(options.now)}/${path}`;
  return await movePath(store, {
    from: path,
    to: destination,
    scope: options.scope,
    now: options.now,
  });
}

/** The word a caller must send to delete something permanently. */
export const DELETE_CONFIRMATION = "permanently delete";

export interface DeleteResult {
  paths: string[];
}

/**
 * Delete permanently.
 *
 * No `.history/` copy is written **and every existing one is purged**, which is
 * the point: if this left a recoverable copy behind, the console would be
 * telling people their file is gone forever while quietly keeping it, and
 * "permanently delete" would be a lie in a UI whose whole job is to be
 * trustworthy about where their data is. Archive is the recoverable one.
 *
 * Writing no new snapshot was never enough on its own, and for a while this
 * function thought it was. Every save of an existing note leaves the version it
 * replaced in `.history/`, so any note that had ever been edited kept its
 * content in the bucket after being "permanently" deleted — invisible, because
 * `isPlumbing` hides `.history/` from the file tree and from every gateway
 * tool, and unreachable, because `canSee` refuses plumbing at every scope. A
 * copy nobody can read is still a copy: it is in the customer's bucket, it is
 * in their storage bill, and it is in the export their provider hands to
 * whoever subpoenas it.
 *
 * Purging it costs nothing that exists. Nothing reads `.history/` — not the
 * console, not `read_note`, not any other tool — so there is no rollback to
 * break, only a claim in `apps/mcp/src/index.js`'s header comment that one is
 * possible. Fix that comment before building the feature, not this function.
 *
 * `confirmation` must be the literal `DELETE_CONFIRMATION`. A boolean flag
 * would be satisfied by any truthy value a buggy caller passed; a specific
 * string cannot be arrived at by accident.
 */
export async function deletePath(
  store: FileStore,
  options: { path: string; confirmation: string; scope: Scope },
): Promise<DeleteResult> {
  if (options.confirmation !== DELETE_CONFIRMATION) {
    throw new FileOpError(
      "CONFIRMATION_REQUIRED",
      "Permanent deletion has to be confirmed explicitly. This cannot be undone — archive it instead if you might want it back.",
    );
  }
  const path = requirePath(options.path);
  assertWritablePath(path);

  const state = await loadPrivacyState(store);
  if (!canSee(path, options.scope, state.rules, state.overrides)) throw notFound();

  const targetIsFolder = await isFolder(store, path);
  const keys = targetIsFolder ? await keysUnder(store, path) : [path];
  if (!targetIsFolder && (await store.get(path)) === null) throw notFound();

  for (const key of keys) await store.delete(key);

  // The half that used to be missing. Deleting a folder purges its history
  // subtree in one go; deleting a file purges the snapshots that share its
  // name. Done after the live keys so a failure mid-purge leaves the bucket in
  // the state the *old* behaviour left it in — file gone, history behind —
  // rather than history gone and the file still sitting there.
  for (const key of await historyKeysFor(store, path, targetIsFolder)) {
    await store.delete(key);
  }

  await forgetPrivacy(store, keys, targetIsFolder ? path : null);

  // `paths` stays the live keys. It is what the console echoes and what the
  // audit log records as "what you deleted"; the history that came with them is
  // plumbing, and listing it would be the first time we ever showed a customer
  // a `.history/` key.
  return { paths: keys };
}

/* -------------------------------------------------------------------------- */
/*                        repairing a broken privacy.md                       */
/* -------------------------------------------------------------------------- */

export interface PrivacyResetResult {
  path: string;
  /** The top-level folders the new manifest declares, all `private`. */
  folders: string[];
  /**
   * Where the unreadable file was kept, or `null` when there was nothing to
   * keep. A person whose manifest merely had a typo has not lost the other
   * forty lines; they are one `.history/` key away.
   */
  backedUpTo: string | null;
  /** True when the walk of the root stopped at the page cap. */
  truncated: boolean;
}

/**
 * Write a working `privacy.md` over a missing or unreadable one.
 *
 * ## Why this exists
 *
 * A bucket whose manifest does not parse fails closed: `loadPrivacyState`
 * returns no rules, every note reads as private, and `mutateManifest` refuses
 * every write — so `setVisibility` and `setFolderVisibility`, the only two ways
 * in, both answer `PRIVACY_MANIFEST_MISSING` or `PRIVACY_MANIFEST_INVALID`. The
 * console said "write a valid privacy.md at the root of the bucket, or ask a
 * connected AI client to", and **neither was possible**: `assertWritablePath`
 * refuses `privacy.md` here, and the gateway's `isPlumbing` refuses it in
 * `write_note` and answers `set_folder_visibility` with "privacy.md is required
 * before folder visibility can be changed". The only exit was rclone or the
 * provider's own web console. This is the exit.
 *
 * ## The four things that keep it from being a hole
 *
 *  1. **It only runs on a manifest that is already broken.** A parseable file
 *     is refused with `PRIVACY_MANIFEST_USABLE`, so this can never be the way
 *     somebody's curated access map gets flattened. That check is the whole
 *     safety argument, and it is the state the console's own banner reports —
 *     `manifestUsable === false` on the root listing is exactly
 *     `text === null || invalid`.
 *  2. **Every folder is written `private`.** The bucket was already failing
 *     closed, so an all-private manifest is the one rewrite under which no note
 *     changes hands. Repairing cannot publish anything, which is why
 *     `renderPrivacyManifestForFolders` takes no visibility argument.
 *  3. **Owner clearance only.** `scope` is `private` for an owner and `team`
 *     for everybody else (`scopeForRole`), and rewriting a context's whole
 *     access map is not an editor's to do — it is the same boundary that keeps
 *     an editor from seeing the private notes the map governs. Checked here as
 *     well as at the action, because this module is the one that is testable
 *     without a session.
 *  4. **The unreadable file is kept.** A manifest that fails to parse usually
 *     fails on one line; the other rules in it are the owner's work and may be
 *     the only record of what was shared with whom. It goes to `.history/`
 *     under the same convention `writeFile` uses, so it is recoverable by the
 *     same route as any other overwritten note.
 *
 * ## Why it declares the bucket's real folders
 *
 * The scaffold writes the five PARA names because it is laying down a bucket
 * that has nothing in it. This runs against a bucket that has a life already —
 * frequently the case this whole feature is for, since a brain synced from
 * Obsidian is exactly the kind that arrives with a hand-edited manifest — so
 * declaring `0-inbox … 4-archive` over somebody's `Journal/` and `Clients/`
 * would hand them a file with no line to edit for any folder they have. The
 * root walk is delimited and bounded like every other listing here; a bucket
 * too wide to finish gets the folders we saw and says the list is short, which
 * costs a line to add by hand and never costs visibility.
 */
export async function resetPrivacyManifest(
  store: FileStore,
  options: { scope: Scope; now: number },
): Promise<PrivacyResetResult> {
  if (options.scope !== "private") {
    // Same wording an editor gets for anything else out of reach, and the
    // action above refuses first. Belt and braces: this module is the one an
    // in-memory test can drive, so the rule is asserted where it can be.
    throw new FileOpError(
      "PRIVACY_MANIFEST_READ_ONLY",
      "Only the owner of a context can rewrite its access map.",
    );
  }

  const state = await loadPrivacyState(store);
  if (state.text !== null && !state.invalid) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_USABLE",
      "privacy.md is readable, so there is nothing to reset. Change a folder or note's visibility instead.",
    );
  }

  const { folders, truncated } = await rootFolders(store);
  const text = renderPrivacyManifestForFolders(folders);

  let backedUpTo: string | null = null;
  if (state.text !== null) {
    // Not `.md`, on purpose: the copy keeps the name of the file it came from,
    // and `.history/` is plumbing that no listing shows either way.
    backedUpTo = `${HISTORY_PREFIX}${PRIVACY_KEY}.${timestampSlug(options.now)}.md`;
    await store.put(backedUpTo, state.text);
  }

  const conditional =
    store.capabilities?.conditionalWrite === true && state.etag !== null;
  const put = conditional
    ? await store.put(PRIVACY_KEY, text, { onlyIf: { etagMatches: state.etag! } })
    : await store.put(PRIVACY_KEY, text);
  if (put === null) {
    // Somebody repaired it — or fixed it by hand in Obsidian — between our read
    // and our write. Theirs stands; re-reading is the console's next move
    // anyway, and it will find a usable manifest.
    throw new FileOpError(
      "CONFLICT",
      "privacy.md changed while it was being repaired. Reload to see what it says now.",
    );
  }

  return { path: PRIVACY_KEY, folders, backedUpTo, truncated };
}

/**
 * The bucket's top-level folders.
 *
 * Delimited, so this is the folder names and not every key under them — the
 * same reason `countNotes` is delimited at the root, and the same trap avoided:
 * a flat listing returns `.history/…` first and would spend the whole page
 * budget inside it.
 *
 * A bucket whose notes all sit at the root has no folders and gets a manifest
 * with none, which parses and is correct: `default_visibility: private` covers
 * everything, and the person can add a line when they make a folder.
 */
async function rootFolders(
  store: FileStore,
): Promise<{ folders: string[]; truncated: boolean }> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: "", delimiter: "/", cursor, limit: 1000 });
    for (const raw of listing.delimitedPrefixes ?? []) {
      const folder = raw.replace(/\/+$/, "");
      // `.history/`, `.audit/`, `.obsidian/`. A manifest line for any of them
      // is rejected by `parsePrivacyManifest`, which would make the repair
      // write a file that does not parse.
      if (!folder || isPlumbing(folder)) continue;
      seen.add(folder);
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
    if (page === LIST_PAGE_CAP - 1) truncated = true;
  }

  return { folders: [...seen].sort(), truncated };
}

/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

export interface VisibilityResult {
  path: string;
  visibility: Visibility;
  inherited: Visibility;
  /** False when the change removed a now-redundant exception. */
  exception: boolean;
}

/**
 * Set one note's visibility, through the manifest.
 *
 * This is the only way visibility changes. Editing `visibility:` in a note's
 * frontmatter does nothing at all — frontmatter is description, the manifest
 * is access control — and that is deliberate: a note's own body must never be
 * able to widen its own audience.
 *
 * Setting a note to its folder's default **removes** the exception rather than
 * writing a redundant line, so the exception list stays a statement of what is
 * unusual. See `nextOverrides`.
 */
export async function setVisibility(
  store: FileStore,
  options: { path: string; visibility: Visibility; scope: Scope },
): Promise<VisibilityResult> {
  const path = requirePath(options.path);
  assertWritablePath(path);
  if (!path.endsWith(".md")) {
    throw new FileOpError(
      "PATH_INVALID",
      "Only markdown notes can have their own visibility. Set the folder's default instead.",
    );
  }

  const state = await mutateManifest(store, (current) => {
    if (!canSee(path, options.scope, current.rules, current.overrides)) throw notFound();
    return {
      rules: current.rules,
      overrides: nextOverrides(path, options.visibility, current.rules, current.overrides),
    };
  });

  const inherited = visibilityOf(path, state.rules);
  return {
    path,
    visibility: options.visibility,
    inherited,
    exception: options.visibility !== inherited,
  };
}

/**
 * Set a folder's default.
 *
 * Every note under it that has no exception of its own follows. Notes that
 * *do* have one keep it — which is exactly why the console shows the default on
 * the folder row and a marker only on the exceptions: the picture on screen is
 * the file on disk.
 */
export async function setFolderVisibility(
  store: FileStore,
  options: { path: string; visibility: Visibility; scope: Scope },
): Promise<VisibilityResult> {
  const folder = requirePath(options.path);
  if (isPlumbing(folder)) throw new FileOpError("PATH_INVALID", "That path is reserved.");

  await mutateManifest(store, (current) => {
    if (
      options.scope !== "private" &&
      !folderVisibleAtScope(folder, options.scope, current.rules, current.overrides)
    ) {
      throw notFound();
    }
    const rules = current.rules.filter((rule) => rule.prefix !== folder);
    rules.push({ prefix: folder, vis: options.visibility });
    // A rule that merely restates the inherited default is still worth
    // keeping: `folder_defaults` is the layer people read and edit by hand,
    // and silently dropping the line they just set would look like a bug.
    return { rules, overrides: current.overrides };
  });

  return {
    path: folder,
    visibility: options.visibility,
    inherited: options.visibility,
    exception: false,
  };
}

/* -------------------------------------------------------------------------- */
/*                          rewriting privacy.md safely                       */
/* -------------------------------------------------------------------------- */

/**
 * Read-modify-write the manifest under compare-and-swap.
 *
 * The manifest is the one file several actors edit concurrently — the console,
 * the gateway on behalf of an AI client, and the customer in Obsidian — and a
 * lost update here is not a lost paragraph, it is a note that was supposed to
 * be private and is not. So the write is conditional on the etag we read, and
 * a failed precondition re-reads and re-applies rather than retrying blind.
 *
 * The same five-attempt loop the gateway's `persistExactVisibility` uses.
 */
async function mutateManifest(
  store: FileStore,
  change: (current: { rules: PrivacyRule[]; overrides: Map<string, Visibility> }) => {
    rules: PrivacyRule[];
    overrides: Map<string, Visibility>;
  },
): Promise<{ rules: PrivacyRule[]; overrides: Map<string, Visibility> }> {
  for (let attempt = 0; attempt < MANIFEST_CAS_ATTEMPTS; attempt += 1) {
    const state = await loadPrivacyState(store);
    if (state.text === null) {
      throw new FileOpError(
        "PRIVACY_MANIFEST_MISSING",
        "This bucket has no privacy.md, so there is nothing to record visibility in. Write one at the root of the bucket — everything stays private until you do.",
      );
    }
    if (state.invalid) {
      throw new FileOpError(
        "PRIVACY_MANIFEST_INVALID",
        "privacy.md could not be read. Fix or remove its managed rules block, then try again.",
      );
    }

    const next = change({ rules: state.rules, overrides: state.overrides });
    const text = replacePrivacyRulesBlock(state.text, next.rules, next.overrides);
    if (text === state.text) return next; // nothing changed; do not churn the file

    const put =
      store.capabilities?.conditionalWrite === true && state.etag !== null
        ? await store.put(PRIVACY_KEY, text, { onlyIf: { etagMatches: state.etag } })
        : await store.put(PRIVACY_KEY, text);
    if (put !== null) return next;
  }
  throw new FileOpError(
    "PRIVACY_MANIFEST_BUSY",
    "Your visibility settings are being changed somewhere else. Try again.",
  );
}

/** Carry exceptions across a move, including the folder's own default rule. */
async function remapPrivacy(
  store: FileStore,
  change: {
    moves: { from: string; to: string }[];
    folderMove: { from: string; to: string } | null;
  },
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return; // nothing to keep in sync

  const touchesOverride = change.moves.some(({ from }) => state.overrides.has(from));
  const touchesRule =
    change.folderMove !== null &&
    state.rules.some(
      (rule) =>
        rule.prefix === change.folderMove!.from ||
        rule.prefix.startsWith(`${change.folderMove!.from}/`),
    );
  if (!touchesOverride && !touchesRule) return;

  await mutateManifest(store, (current) => {
    let rules = current.rules;
    if (change.folderMove !== null) {
      const { from, to } = change.folderMove;
      rules = current.rules.map((rule) =>
        rule.prefix === from || rule.prefix.startsWith(`${from}/`)
          ? { prefix: `${to}${rule.prefix.slice(from.length)}`, vis: rule.vis }
          : rule,
      );
    }
    let overrides = current.overrides;
    for (const move of change.moves) {
      overrides = movedOverrides(move.from, move.to, rules, overrides);
    }
    return { rules, overrides };
  });
}

/** Give a copy the same exception as its original, where it is still one. */
async function copyPrivacy(
  store: FileStore,
  pairs: { from: string; to: string }[],
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;
  if (!pairs.some(({ from }) => state.overrides.has(from))) return;

  await mutateManifest(store, (current) => {
    let overrides = current.overrides;
    for (const pair of pairs) {
      const existing = current.overrides.get(pair.from);
      if (existing === undefined) continue;
      overrides = nextOverrides(pair.to, existing, current.rules, overrides);
    }
    return { rules: current.rules, overrides };
  });
}

/** Drop rules for things that no longer exist. */
async function forgetPrivacy(
  store: FileStore,
  keys: string[],
  deletedFolder: string | null,
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;

  const hasOverride = keys.some((key) => state.overrides.has(key));
  const hasRule =
    deletedFolder !== null &&
    state.rules.some(
      (rule) => rule.prefix === deletedFolder || rule.prefix.startsWith(`${deletedFolder}/`),
    );
  if (!hasOverride && !hasRule) return;

  await mutateManifest(store, (current) => {
    let overrides = current.overrides;
    for (const key of keys) overrides = clearedOverrides(key, overrides);
    const rules =
      deletedFolder === null
        ? current.rules
        : current.rules.filter(
            (rule) =>
              rule.prefix !== deletedFolder && !rule.prefix.startsWith(`${deletedFolder}/`),
          );
    return { rules, overrides };
  });
}
