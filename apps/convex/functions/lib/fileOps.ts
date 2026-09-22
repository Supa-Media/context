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

import { canReplaceEncryptedNote, isEncryptedNote } from "./noteEncryption";
import {
  PRIVACY_KEY,
  type PrivacyRule,
  type Scope,
  type Visibility,
  canSee,
  clearedOverrides,
  effectiveVisibility,
  narrowerVisibility,
  foldPath,
  hasOverride,
  isPlumbing,
  movedOverrides,
  nextOverrides,
  overrideFor,
  parsePrivacyManifest,
  renderPrivacyRulesBlock,
  replacePrivacyRulesBlock,
  visibilityOf,
  archiveRoot,
  archiveRoots,
  insideArchive,
} from "./privacy";
import { type Clearance } from "./clearance";
import { renderPrivacyManifestForFolders, type ScaffoldStore } from "./scaffold";
import { indexByName, rewriteLinks } from "@context/shared/src/links";
import { WORKSPACE_ICON_EXTENSIONS } from "@context/shared/src/workspaceIcon";
import { HISTORY_PREFIX, IMAGE_PREFIX, legacyStorageKey } from "@context/shared/src/storageLayout.cjs";
// The gateway's search, imported rather than ported — see `searchNotes` below.
// `apps/mcp` targets the Workers runtime, which is Convex's runtime too, so
// these run here unmodified over the same store `provisioning.ts` already
// builds from a binding.
import { forwardPath, readForwarding, recordForwarding } from "../../../mcp/src/forwarding.js";
import { pruneEmptyFolders } from "../../../mcp/src/store/index.js";
import { createSearchBudget } from "../../../mcp/src/search/maintain.js";
import { loadDocmapPaths, syncShardedIndex } from "../../../mcp/src/search/shards.js";
import { searchIndexedNotes } from "../../../mcp/src/search/visible.js";
import { answerFromProjection, pageDepth } from "../../../mcp/src/search/d1/serve.js";
import {
  eligible as collaborationEligible,
  moveDocument as moveCollaborationDocument,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
  sealDocument as sealCollaborationDocument,
  supported as collaborationSupported,
  tombstoneDocument as tombstoneCollaborationDocument,
} from "@context/collaboration";
// The projection, on the same terms. `projectPass`, `loadCensus` and
// `progressFrom` take a store, a census, a `visibilityOf` and a budget and
// know nothing about a gateway request — which is what makes the control
// plane's scheduled half the same import rather than a second copy.
import {
  censusFromManifest,
  loadCensus,
  progressFrom,
  projectPass,
  worthReporting,
} from "../../../mcp/src/search/d1/backfill.js";

/* -------------------------------------------------------------------------- */
/*                                   limits                                   */
/* -------------------------------------------------------------------------- */

/** S3 caps keys at 1024; the gateway's `normalizePath` caps paths at 512. */
const MAX_PATH_LENGTH = 512;
/** One note. Generous for markdown, small enough that a paste cannot DoS an action. */
export const MAX_NOTE_BYTES = 2_000_000;
/** Pages of a listing we will walk. 1000 keys each. */
// Matched to the gateway's own `LIST_PAGE_CAP`. They disagreed at 20 vs 100,
// which meant a folder `list_notes` walked happily was refused by the console —
// and the page size is a *hint*: S3 may return fewer keys than `max-keys` and
// Dropbox documents `limit` as approximate, so the object count this actually
// corresponds to is provider-dependent and can be far lower than the arithmetic
// suggests. A cap that fires on an ordinary folder is an outage, and the answer
// here is a refusal rather than a silent half-operation.
const LIST_PAGE_CAP = 100;
/** Keys a single folder move/copy/delete may touch. Same cap the gateway uses. */
export const FOLDER_OPERATION_CAP = 500;
/** Attempts at the compare-and-swap that rewrites `privacy.md`. */
const MANIFEST_CAS_ATTEMPTS = 5;

/**
 * Legacy only. Nothing writes a `.history/` snapshot any more — versioning is
 * the customer's to enable at their provider — but buckets connected before
 * that change are full of them, so `deletePath` still purges what it finds.
 */

/**
 * Where the one copy this product still keeps for somebody goes.
 *
 * `.context/` is ours the way `.audit/` is: a dot-prefixed segment, so every
 * `isPlumbing` check in both engines already refuses it without being told,
 * and `.context-probe/` is a different segment that no prefix test collides
 * with. `recover/` under it is for a file we replaced that the owner may want
 * back — today only the unreadable `privacy.md` that `resetPrivacyManifest`
 * repairs, whose other forty lines are their record of what was shared.
 *
 * This is deliberately not a general history. It is owner-triggered, one file
 * per repair, and it exists because that file is not recoverable from anywhere
 * else — not from versioning the customer may not have enabled, and not from
 * the notes, which is the test for whether anything else belongs here.
 */
const RECOVER_PREFIX = ".context/recover/";
const TRASH_ROOT = ".context/trash";

/**
 * Retired as a constant: which folder is *the* archive is a question about the
 * context's own manifest, not a literal. See `archiveRoot` in `lib/privacy.ts`.
 */

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
  delete(
    key: string,
    options?: { onlyIf?: { etagMatches?: string } },
  ): Promise<void | null>;
  capabilities?: {
    conditionalWrite: boolean;
    conditionalCreate?: boolean;
    conditionalDelete?: boolean;
  };
}

/** Keys removed per retryable replacement pass. Small enough for every provider. */
export const VAULT_CLEAR_BATCH_OBJECTS = 100;

/**
 * Count or remove a bounded piece of a bucket for an explicitly confirmed
 * vault replacement. This deliberately sees plumbing: "replace everything"
 * means notes, attachments, privacy, audit, and derived indexes alike.
 *
 * Deletion always lists from the beginning. Persisting a continuation cursor
 * while mutating the same listing can skip keys on S3-compatible providers;
 * shrinking the first page makes every retry safe, including a retry after
 * the objects were deleted but before Convex recorded the count.
 */
export async function clearVaultBatch(
  store: FileStore,
  countOnly: boolean,
): Promise<{ mode: "counted" | "deleted"; objects: number; complete: boolean }> {
  if (countOnly) {
    let cursor: string | undefined;
    let objects = 0;
    for (let pageNumber = 0; pageNumber < LIST_PAGE_CAP; pageNumber += 1) {
      const page = await store.list({ cursor, limit: 1_000 });
      objects += page.objects.length;
      if (!page.truncated) return { mode: "counted", objects, complete: true };
      if (!page.cursor || page.cursor === cursor) {
        throw new FileOpError(
          "LISTING_INCOMPLETE",
          "Context could not finish counting this bucket. Try again before replacing it.",
        );
      }
      cursor = page.cursor;
    }
    throw new FileOpError(
      "FOLDER_TOO_LARGE",
      "This bucket is too large to replace safely in this flow.",
    );
  }

  const page = await store.list({ limit: VAULT_CLEAR_BATCH_OBJECTS });
  for (const object of page.objects) await store.delete(object.key);
  return {
    mode: "deleted",
    objects: page.objects.length,
    complete: page.truncated !== true,
  };
}

/**
 * What the imported search needs of a store: reads, listings and the
 * conditional write its index maintenance does. `FileStore` satisfies it —
 * the cast at the call site is because `apps/mcp` is JavaScript with no
 * exported type to line these up structurally, not because anything is
 * missing.
 */
type SearchStore = Parameters<typeof searchIndexedNotes>[0];

/**
 * Store operations one console search may spend.
 *
 * It no longer buys a backfill. A search reads a ready index — the change that
 * took a console search over a real workspace from twenty-odd seconds to a
 * fraction of one — so what this covers is a manifest, the shards the query's
 * terms can be in, ten snippet reads, and the one listing a **miss** over a
 * converged index is allowed to buy before it says "nothing". Generous rather
 * than tight because a Convex action has no subrequest ceiling and the cost of
 * being one op short is an answer that understates itself.
 */
const CONSOLE_SEARCH_BUDGET = 300;

/**
 * Store operations one background maintenance pass may spend.
 *
 * This is where every listing, note read and shard write in the console's half
 * of the system now happens, and nobody is waiting on it: it runs in a
 * scheduled action, after the search that noticed the index was behind has
 * already answered. Cloudflare's per-invocation subrequest cap is what bounds
 * the gateway's equivalent and there is no such cap here, so the number is
 * chosen against the customer's request quota instead — large enough that a
 * cold workspace converges in a handful of passes rather than dozens.
 */
const INDEX_SYNC_BUDGET = 600;

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
  /** `readFiles` was asked for more paths than one call may name. */
  | "BATCH_TOO_LARGE"
  | "FOLDER_TOO_LARGE"
  | "STORAGE_UNSAFE"
  | "PLUGIN_TOO_LARGE"
  /**
   * The Context plugin this operation belongs to is switched off here.
   *
   * Its own code rather than `CONFIRMATION_REQUIRED` or `CONFLICT`, because it
   * means something neither of those does to whoever is holding the editor:
   * retrying will not help and there is nothing to reload — an owner turns the
   * plugin back on, or this does not happen. See `plugins.md`.
   */
  | "PLUGIN_OFF"
  /** The store would not hand over the whole listing. Not the folder's fault. */
  | "LISTING_INCOMPLETE"
  | "ARCHIVE_UNAVAILABLE"
  | "CONFIRMATION_REQUIRED"
  /**
   * The note at that path is stored encrypted, so this path may not write it.
   *
   * Its own code rather than `CONFLICT`, because the two mean opposite things
   * to whoever is holding the editor: a conflict says reload and try again, and
   * this says a write through this door cannot succeed at all.
   *
   * Also the code `removeNoteEncryption` refuses its own misuse with — a
   * replacement that is itself still an encrypted note — since that is the same
   * claim in the other direction: this door writes plaintext, and only
   * plaintext, over an encrypted note.
   */
  | "NOTE_ENCRYPTED"
  /** `removeNoteEncryption` asked to act on a note that was never encrypted. */
  | "NOTE_NOT_ENCRYPTED"
  | "NOT_A_FOLDER"
  /**
   * The five a markdown form refuses with. See `lib/formOps.ts`.
   *
   * Separate codes rather than one, because the console does something
   * different with each: `FORM_NOT_FOUND` and `FORM_INVALID` are the author's
   * to fix and name a block, `FORM_FORBIDDEN` is the reader's answer and must
   * read as a refusal rather than a fault, `FORM_NOT_COLLECTING` is a form an
   * editor has to save once more, and `FORM_STORAGE_UNSUITABLE` is a property
   * of the customer's store that no retry will change.
   */
  | "FORM_NOT_FOUND"
  | "FORM_INVALID"
  | "FORM_FORBIDDEN"
  | "FORM_NOT_COLLECTING"
  | "FORM_STORAGE_UNSUITABLE";

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
  // No control characters, and a newline is the one that mattered.
  //
  // `privacy.md` is a line-oriented format and `renderPrivacyRulesBlock`
  // interpolates a path into it unescaped, so a path carrying `\n` wrote its
  // own extra rules. Measured on this door before the fix: one
  // `setFolderVisibility` declaring **private** for
  // `2-areas/hr: team\n  1-projects/junk` published `2-areas/hr` to the whole
  // team, and one `setVisibility` declaring **private** for
  // `2-areas/salaries.md: team\n  1-projects/junk.md` left
  // `note_overrides` holding that note twice — `private` then `team`, the
  // later winning. The call declared `private` both times, so the console
  // asked for no publish confirmation.
  //
  // The hostile input is a KEY IN THE BUCKET, not the owner's typing:
  // `writableAsRule`'s own docstring says a newline is a legal S3 key
  // character and names this exact escalation. Obsidian sync, rclone and the
  // provider console all write keys directly.
  //
  // Rejected here, where every path argument arrives, rather than escaped at
  // the renderer: a path with a control character in it is not a path worth
  // preserving. `#422` did this in the gateway; this is the same fix on the
  // other engine.
  if (/[\u0000-\u001F\u007F]/.test(clean)) return null;
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
  clearance: Clearance,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): boolean {
  if (isPlumbing(folderPath)) return false;
  if (clearance.scope === "private") return true;
  // A name the caller answers to reaches a folder exactly as `team` does, and
  // every `=== "team"` below had to learn the same thing. Missing one of them
  // is the defect that made a group-named folder readable by direct path and
  // absent from the tree: reachable only by somebody who already knew its name,
  // which is the failure `folderVisibleAtScope`'s own nested-rule scan exists
  // to prevent.
  const reaches = (visibility: Visibility) =>
    visibility === "team" || clearance.names.has(visibility);
  if (reaches(visibilityOf(folderPath, rules))) return true;
  for (const [path, visibility] of overrides) {
    if (reaches(visibility) && path.startsWith(`${folderPath}/`)) return true;
  }
  // A nested `team` *rule* has to count for the same reason a nested `team`
  // exception does, and only the exceptions were being scanned. An owner who
  // shared `2-areas/shared` out of a private `2-areas` got a folder that read
  // fine by direct path and did not appear in the tree at all — the root
  // listing came back empty and `2-areas` answered not-found — so the thing
  // they had just shared was reachable only by somebody who already knew its
  // name. The disclosure is the same one the loop above already accepts: an
  // ancestor's name, in exchange for the shared folder being reachable.
  for (const rule of rules) {
    if (reaches(rule.vis) && rule.prefix.startsWith(`${folderPath}/`)) return true;
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
    readOnly: foldPath(key) === PRIVACY_KEY,
    ...extra,
  };
}

/** One folder's immediate children, as the tree renders them. */
export async function listFolder(
  store: FileStore,
  options: { path: string; clearance: Clearance },
): Promise<FolderListing> {
  const folder = requireFolderPath(options.path);
  const state = await loadPrivacyState(store);

  // **A folder the caller cannot see answers exactly as one that is not there,
  // and refusing is not how you do that.**
  //
  // Refusing looked like the safe direction and is the leak. A name that does
  // not exist inherits its parent's default, so under a team-visible parent it
  // is VISIBLE and returns an empty listing — while a name that exists and is
  // private refuses. Two different answers, and the difference is exactly the
  // fact being withheld: a member who guesses a folder name is told whether it
  // is there. `privacy.md` is kept from team scope because "handing it to a
  // team-scoped caller would enumerate every private folder by name"; this was
  // that, one guess at a time.
  //
  // It read as collapsed because the test for it compared two folders at the
  // ROOT, where the default is private and a nonexistent name is refused too.
  // The axis that fixture held constant is the one the collapse turns on.
  //
  // So the empty shape is returned instead of a refusal. `readFile` has always
  // done the equivalent — a note it cannot see and a note that is not there
  // both throw — and this is the same collapse for the other direction, since
  // an empty listing is what an absent folder already produces here.
  const withheld =
    folder !== "" &&
    !folderVisibleAtScope(folder, options.clearance, state.rules, state.overrides);

  const prefix = folder === "" ? "" : `${folder}/`;
  const entries: FileEntry[] = [];
  const seenFolders = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;
  // **A withheld folder is walked exactly as any other, and skipping the walk
  // was a bug I wrote here and then measured.**
  //
  // Skipping looks like the free optimisation: `canSee` filters every entry
  // out anyway, so the answer cannot differ. But the absent folder still walks
  // — it has to, to discover there is nothing — so skipping made the withheld
  // case do strictly less work than the case it is supposed to be
  // indistinguishable from. Counted: 0 store listings against 1. The result
  // collapsed and the clock came apart, which is the same oracle one layer
  // down.
  // ...and it is walked for exactly one page, because that is what an absent
  // folder costs. `limit` is a hint — the store is the customer's, and Dropbox
  // documents its own as approximate — so a page of ten turns a sixty-object
  // private folder into six round trips against the absent folder's one, and
  // past `LIST_PAGE_CAP` pages the body comes apart too: `truncated: true`
  // against `false`. Both the clock and a boolean would then scale with the
  // size of the thing being hidden, which is a coarser oracle than the name it
  // was hiding.
  const pages = withheld ? 1 : LIST_PAGE_CAP;

  for (let page = 0; page < pages; page += 1) {
    const listing = await store.list({ prefix, delimiter: "/", cursor, limit: 1000 });

    for (const object of listing.objects ?? []) {
      const key = object.key;
      if (key === prefix) continue; // a zero-byte folder marker, if a tool made one
      if (!canSee(key, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) continue;
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
      if (!folderVisibleAtScope(child, options.clearance, state.rules, state.overrides)) continue;
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

    // `truncated` and `cursor` come from two independent tags and nothing makes
    // them agree: `readTag` in `apps/mcp/src/store/s3.js` reads `IsTruncated`
    // from one element and `NextContinuationToken` from another, so a store
    // that sets the first without the second arrives here as
    // `{ truncated: true, cursor: undefined }`. Every walk in this file used to
    // fold that into one `||` with a finished listing, which is the opposite
    // reading: not finished, unable to continue. The endpoint belongs to the
    // customer, so the store answering slightly wrong is a provider or proxy
    // they chose, publishing their own notes — B2, Wasabi, MinIO and anything
    // a self-hosted gateway points at are all in scope, and "only a
    // nonconforming store does this" is the reasoning that put it here.
    //
    // The five other walks below share this shape. Where they can still refuse
    // they refuse; the two that report — this one and `rootFolders` — say the
    // listing is short, because a floor printed as a total is #25 with a
    // measurement in front of it.
    if (!listing.truncated) break;
    if (!listing.cursor) {
      truncated = true;
      break;
    }
    cursor = listing.cursor;
    if (page === LIST_PAGE_CAP - 1) truncated = true;
  }

  entries.sort(compareEntries);

  return {
    path: folder,
    // A withheld folder reports the default an absent one would: its own rule
    // is the fact being withheld, and printing it here would hand back through
    // the shape what the refusal was hiding.
    //
    // The ancestor has to be the nearest VISIBLE one and not the immediate
    // parent, which is where the first version of this leaked. At depth one the
    // two are the same and it read as correct; one level down the parent IS the
    // private folder, so the branch written to withhold a rule printed exactly
    // that rule — `1-projects/secret/anything` answering "private" where
    // `1-projects/guess/anything` answered "team", for a guessed segment that
    // need not exist. Every ancestor that survives this walk is one the caller
    // can already list, so it publishes nothing they could not read off their
    // own tree.
    folderDefault: withheld
      ? visibilityOf(
          nearestVisibleAncestor(folder, options.clearance, state.rules, state.overrides),
          state.rules,
        )
      : folder === ""
        ? visibilityOf("", state.rules)
        : visibilityOf(folder, state.rules),
    // **`truncated` is load-bearing here, and a first draft of this comment
    // called it belt and braces on a reason that is false.**
    //
    // "One page never truncates" is wrong: the no-cursor branch above fires on
    // page zero for any non-empty prefix, because that is what a store setting
    // `IsTruncated` without a `NextContinuationToken` produces — the exact
    // nonconforming shape the block above names B2, Wasabi, MinIO and
    // "anything a self-hosted gateway points at" as producing. Against such a
    // store, and with this conditional removed, a withheld folder answers
    // `truncated: true` where an absent one answers `false`: one boolean, in
    // the body, saying whether the private folder is there. On a supported
    // self-hosting path.
    //
    // It survives sabotage only because the one-page walk masks it on a
    // CONFORMING store, so the test below uses a nonconforming one. Two
    // mechanisms that mask each other are one mechanism with a spare, and the
    // comment has to say which is which — otherwise the sentence claiming it is
    // redundant is the sentence that deletes it.
    //
    // `entries` is the weaker of the pair and kept on the same grounds: the
    // filters above run over whatever keys the customer's store actually
    // returned, and the store is theirs.
    entries: withheld ? [] : entries,
    truncated: withheld ? false : truncated,
    manifestUsable: state.text !== null && !state.invalid,
  };
}

/**
 * The nearest ancestor of `folder` visible at `scope`, or `""` for the root.
 *
 * Used only for a withheld folder's reported default, and the walk is the whole
 * point: it steps over every ancestor the caller cannot see, so the word it
 * ends up printing is one they could have read off their own tree anyway.
 *
 * "Off their own tree" is true and is not by itself enough — it does not
 * obviously close the case of a path several levels below anything visible. The
 * tight argument is that `folderVisibleAtScope` is **upward-closed**: a team
 * rule or override beneath `F` is also beneath every ancestor of `F`, so if `F`
 * is visible its whole ancestor chain is. What this returns is therefore the
 * LONGEST VISIBLE PREFIX of the queried path — which the caller can compute
 * unaided by listing down from the root, and can query directly, since being
 * visible is exactly what stops it being withheld. At any depth, it can only
 * print something they already had.
 */
function nearestVisibleAncestor(
  folder: string,
  clearance: Clearance,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): string {
  let at = parentOf(folder);
  while (at !== "" && !folderVisibleAtScope(at, clearance, rules, overrides)) {
    at = parentOf(at);
  }
  return at;
}

/** Folders first, then files, each alphabetically — the order Obsidian uses. */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

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

export interface SyncManifest {
  /** In the store's key order. */
  entries: ManifestEntry[];
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
  const short = (): SyncManifest => ({ entries: [], cursor: null, truncated: true, manifestUsable });

  const entries: ManifestEntry[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let ordered = true;
  let previous: string | undefined;
  let token: string | undefined;

  /** Stop here, with a cursor only where one can be honoured and moves on. */
  const stop = (): SyncManifest => {
    if (!ordered || entries.length === 0) {
      return { ...short(), entries };
    }
    return { entries, cursor: entries[entries.length - 1]!.path, truncated: false, manifestUsable };
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
      return { entries, cursor: null, truncated: false, manifestUsable };
    }
    // Truncated with nowhere to go, or a cursor seen before: the store cannot
    // finish this walk. See `listFolder` and `keysUnder` for the shapes.
    if (!listing.cursor || seenCursors.has(listing.cursor)) {
      return { ...short(), entries };
    }
    seenCursors.add(listing.cursor);
    token = listing.cursor;
  }
  // The page budget ran out mid-bucket. Resumable from the last path returned
  // where there is one; otherwise this call learned nothing it can hand on.
  return stop();
}

/* -------------------------------------------------------------------------- */
/*                                   reading                                  */
/* -------------------------------------------------------------------------- */

export interface FileContents {
  path: string;
  text: string;
  etag: string;
  /** Provider object version, retained for mirror freshness checks. */
  rawEtag?: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  /** `privacy.md`. The console shows it with an explanation instead of a textarea. */
  readOnly: boolean;
  /**
   * The note is stored encrypted, and this response is its ciphertext.
   *
   * The console shows a locked note rather than an editor. `readOnly` is forced
   * true beside it, which is what makes the *existing* console behave correctly
   * on a build that has never heard of this field — the same treatment
   * `privacy.md` already gets, and the reason the flag is additive rather than a
   * new mode.
   *
   * The control plane holds no key, so there is nothing here to decrypt with.
   * See `functions/lib/noteEncryption.ts` for why that is deliberate.
   */
  encrypted: boolean;
  /** Stable collaboration generation and complete Yjs base for supported notes. */
  documentId?: string;
  update?: string;
}

export async function readFile(
  store: FileStore,
  options: { path: string; clearance: Clearance; forward?: "never" | "onMiss" },
): Promise<FileContents> {
  const path = requirePath(options.path);
  const state = await loadPrivacyState(store);
  if (options.forward !== "onMiss") {
    return await readVisibleFile(store, state, path, options.clearance);
  }

  /*
    A STALE ADDRESS IS FORWARDED, AFTER IT HAS MISSED AND NEVER BEFORE.

    A path means what it says *today*: if a note lives where the address
    points, that note is the answer, even when something else once lived there.
    Only an address that resolves to nothing has anything to gain from the
    forwarding ledger — which also keeps the extra GET off every successful
    read.

    A share is the one caller that needs the opposite order, because its grant
    was minted on a *note* rather than on a string. It resolves through the
    `forward` operation before it reads, for the reasons in `shares.ts`; the
    two orders are deliberately not one rule.

    The destination still goes through `readVisibleFile`, so `canSee` is
    re-asked there and a forward can never widen what a caller reaches.
  */
  try {
    return await readVisibleFile(store, state, path, options.clearance);
  } catch (error) {
    if (!(error instanceof FileOpError) || error.code !== "FILE_NOT_FOUND") throw error;
    const forwarded = forwardPath(await readForwarding(store), path);
    if (forwarded === path) throw error;
    return await readVisibleFile(store, state, forwarded, options.clearance);
  }
}

/**
 * The body of `readFile`, against a manifest already loaded — so `readFiles`
 * reads a batch through exactly this, and a single read and a batched one
 * cannot come to disagree about who may see a note.
 */
async function readVisibleFile(
  store: FileStore,
  state: PrivacyState,
  path: string,
  clearance: Clearance,
): Promise<FileContents> {
  if (!canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();

  const object = await store.get(path);
  if (object === null) throw notFound();

  const described = describeFile(path, state.rules, state.overrides);
  const text = await object.text();
  // The ciphertext is returned rather than withheld: it is what is in the
  // bucket, the caller has already passed `canSee`, and the file says in its own
  // plain frontmatter what it is. What changes is that it is never editable —
  // `readOnly` is forced, so an older console that ignores `encrypted` still
  // refuses to put it in a textarea.
  const encrypted = isEncryptedNote(text);
  let collaboration: { documentId: string; update: string; text: string; etag: string; rawEtag: string } | null = null;
  if (!encrypted && collaborationSupported(store) && collaborationEligible(path, text)) {
    try {
      collaboration = await readCollaborationDocument(store, path);
    } catch {
      throw new FileOpError(
        "STORAGE_UNSAFE",
        "This note cannot be opened safely for collaborative editing right now.",
      );
    }
  }
  return {
    path,
    text: collaboration?.text ?? text,
    etag: collaboration?.etag ?? object.etag,
    ...(collaboration ? { rawEtag: collaboration.rawEtag } : {}),
    visibility: described.visibility,
    inherited: described.inherited,
    exception: described.exception,
    readOnly: described.readOnly || encrypted,
    encrypted,
    ...(collaboration
      ? { documentId: collaboration.documentId, update: collaboration.update }
      : {}),
  };
}

/** Paths one `readFiles` call may name. */
export const READ_BATCH_PATHS = 50;
/**
 * Note bytes one `readFiles` call may return: two of the largest note the
 * console will write. Past it the rest are deferred rather than read, so a
 * batch of big notes cannot make a response nothing can carry.
 */
export const READ_BATCH_BYTES = 2 * MAX_NOTE_BYTES;

/**
 * One path's answer in a batch.
 *
 * `read` carries exactly what `readFile` returns. `error` carries a refusal's
 * code and message — `FILE_NOT_FOUND` for a note that is missing *and* for one
 * the caller may not see, identically, because both came from `readFile`'s own
 * `notFound()`. `deferred` means the byte budget was spent before this path was
 * looked at: ask again, nothing is implied about the path.
 */
export type BatchRead =
  | { path: string; outcome: "read"; note: FileContents }
  | { path: string; outcome: "error"; code: FileErrorCode; message: string }
  | { path: string; outcome: "deferred" };

/**
 * Read several notes at once, for the offline mirror to fill itself.
 *
 * Every path goes through `readVisibleFile`, the body of `readFile`, against
 * one load of `privacy.md` — so the batch is N single reads sharing a manifest,
 * not a second privacy path. A refusal is per path and does not fail the batch:
 * one note deleted since the manifest was taken must not stop the other
 * forty-nine arriving.
 *
 * `path` on each answer echoes what was asked, so a caller can match answers
 * to requests even for a path that did not normalise. Answers come back in
 * request order.
 *
 * The budget is spent only by notes that were read, which only a visible note
 * is, and once it is spent nothing further is looked at. So whether a path is
 * `deferred` turns on the sizes of notes the caller can read and never on
 * whether a hidden one exists. The first note always reads, whatever its size,
 * so every batch makes progress.
 */
export async function readFiles(
  store: FileStore,
  options: { paths: readonly string[]; clearance: Clearance },
): Promise<BatchRead[]> {
  if (options.paths.length > READ_BATCH_PATHS) {
    throw new FileOpError(
      "BATCH_TOO_LARGE",
      `Read at most ${READ_BATCH_PATHS} notes at a time.`,
    );
  }
  if (options.paths.length === 0) return [];

  const state = await loadPrivacyState(store);
  const results: BatchRead[] = [];
  let bytes = 0;
  let spent = false;
  for (const requested of options.paths) {
    if (spent) {
      results.push({ path: requested, outcome: "deferred" });
      continue;
    }
    try {
      const note = await readVisibleFile(store, state, requirePath(requested), options.clearance);
      const size = byteLength(note.text);
      if (bytes > 0 && bytes + size > READ_BATCH_BYTES) {
        spent = true;
        results.push({ path: requested, outcome: "deferred" });
        continue;
      }
      bytes += size;
      results.push({ path: requested, outcome: "read", note });
    } catch (error) {
      // A refusal is this path's answer. Anything else is the bucket failing,
      // which is the whole batch's problem and goes up as one.
      if (!(error instanceof FileOpError)) throw error;
      results.push({ path: requested, outcome: "error", code: error.code, message: error.message });
    }
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*                                   writing                                  */
/* -------------------------------------------------------------------------- */

export interface WriteResult {
  path: string;
  etag: string;
  /**
   * What was written, in bytes, for `activity.md`.
   *
   * `byteLength`, not `String.length`: the activity file's substance test is a
   * byte threshold, and it must not be laxer for a note written in English
   * than for one written in Yoruba.
   *
   * There is deliberately no `previousBytes` beside it. The store's `get`
   * returns a handle without a size, so knowing what was there before would
   * mean reading the old body on every save — a second full read per
   * keystroke-triggered autosave, to answer a question the activity file
   * already answers another way: an unknown size counts as substantial, and
   * the merge window collapses a typing session into one line whatever the
   * sizes were. The gateway, which has the old body in hand for its own
   * conflict message, does send both.
   */
  bytes: number;
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

export interface VaultImportFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface VaultImportResult {
  created: string[];
  skipped: string[];
  bytesCreated: number;
}

export const MAX_VAULT_IMPORT_FILE_BYTES = 4_500_000;

const VAULT_IMPORT_CONTENT_TYPES = new Set([
  "text/markdown; charset=utf-8",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/octet-stream",
]);

/**
 * Put a bounded piece of an Obsidian vault into its original bucket path.
 *
 * This is create-only. A retry skips files that landed before a connection
 * failed, and an import into a bucket somebody has already edited never
 * overwrites their newer copy. Hidden folders are refused again here rather
 * than trusted to the browser's picker; `.obsidian` can contain plugin tokens
 * and `.context`/`.audit` are Context's own plumbing.
 *
 * **Create-only is enforced two ways, because one of them is not always
 * available.** `onlyIf: { absent: true }` is what every adapter in this
 * codebase *sends*; whether the bucket behind it obeys is a different
 * question, and the one `initialCapabilities()` answers `false` to until a
 * probe says otherwise — "B2 and arbitrary S3-compatible endpoints do not
 * reliably" support conditional writes. Sending the precondition anyway and
 * trusting the reply is how a write that should have been skipped comes back
 * reported as created, with the owner's own file gone under it: the "lost
 * write with no error" that same comment calls the one failure mode a notes
 * product cannot have, arriving here during onboarding over the vault they
 * are importing. So the capability decides, exactly as `saveNote` and the
 * manifest writers already do, and an unproven backend gets a read-then-create
 * whose residual race is one round trip — the same window `scaffold.ts`
 * documents rather than defends.
 */
export async function importVaultFiles(
  store: FileStore,
  options: { files: readonly VaultImportFile[]; clearance: Clearance },
): Promise<VaultImportResult> {
  const state = await loadPrivacyState(store);
  const conditional = store.capabilities?.conditionalWrite === true;
  const created: string[] = [];
  const skipped: string[] = [];
  let bytesCreated = 0;

  for (const file of options.files) {
    const path = requirePath(file.path);
    assertWritablePath(path);
    if (path.split("/").some((segment) => segment.startsWith("."))) {
      throw new FileOpError("PATH_INVALID", "Hidden folders are not uploaded from an Obsidian vault.");
    }
    if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
    if (file.bytes.byteLength > MAX_VAULT_IMPORT_FILE_BYTES) {
      throw new FileOpError(
        "CONTENT_TOO_LARGE",
        `A vault file must be at most ${MAX_VAULT_IMPORT_FILE_BYTES} bytes.`,
      );
    }
    if (!VAULT_IMPORT_CONTENT_TYPES.has(file.contentType)) {
      throw new FileOpError("PATH_INVALID", "That vault file type cannot be uploaded safely.");
    }

    // The precondition makes retries idempotent and closes the race between a
    // preceding GET and PUT — where the bucket honours it. Where the binding
    // has not proven it does, the read is the check, and the one-round-trip
    // window is stated rather than papered over.
    if (!conditional && (await store.get(path)) !== null) {
      skipped.push(path);
      continue;
    }
    const put = conditional
      ? await store.put(path, file.bytes, {
          onlyIf: { absent: true },
          contentType: file.contentType,
        })
      : await store.put(path, file.bytes, { contentType: file.contentType });
    if (put === null) {
      skipped.push(path);
    } else {
      created.push(path);
      bytesCreated += file.bytes.byteLength;
    }
  }

  return { created, skipped, bytesCreated };
}

/**
 * Save a note.
 *
 * `expectedEtag` is the etag the editor read. A mismatch is a **conflict**,
 * surfaced with the current etag so the console can say "this changed
 * elsewhere" and offer to reload — never a silent overwrite.
 *
 * Omitting `expectedEtag` means "this is new": if the key already exists that
 * is also a conflict, not an overwrite — and where the bucket can enforce it
 * (`conditionalCreate`), the put itself is `onlyIf: { absent: true }`, so that
 * holds even for a file created between the check and the write. That is the
 * create mode an offline-queued new note uses. There is no way to say "clobber
 * whatever is there", by design.
 */
export async function writeFile(
  store: FileStore,
  options: {
    path: string;
    text: string;
    expectedEtag?: string;
    clearance: Clearance;
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
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const existing = await store.get(path);

  /*
   * AND A CREATE ASKS A SECOND QUESTION: DOES THE FOLDER ADMIT A NOTE FROM
   * THIS TIER?
   *
   * `canSee` above is the read direction, and its comment is right about it.
   * It is not sufficient for a CREATE, because it honours an exact override —
   * and **an override can outlive the note it was written for.** `trashPath`
   * deliberately leaves one behind: `restoreTrashedPath` re-checks `canSee` at
   * the original path, so the exception has to survive for a restored note to
   * come back at the visibility it had. (`deletePath` is permanent and clears
   * it; the two differ on purpose.)
   *
   * In the window between, the manifest names a path with no object at it. A
   * team caller writing there passed `canSee` on the dead note's exception and
   * created a note **inside a folder the owner keeps private** — the thing
   * `scope_info` advertises as outside their write surface.
   *
   * The gateway's `write_note` has always asked this, and its answer is the
   * one ported here: not "can this caller see this path" but "what does the
   * FOLDER say", which `visibilityOf` answers without consulting overrides.
   * `notFound()` rather than a permission error, to match the refusal above:
   * a distinct message here would make the folder's default an oracle.
   */
  if (existing === null && options.clearance.scope !== "private") {
    const inherited = visibilityOf(path, state.rules);
    if (inherited !== "team" && !options.clearance.names.has(inherited)) throw notFound();
  }

  /*
   * AN ENCRYPTED NOTE IS NOT OVERWRITTEN WITH PLAINTEXT THROUGH THIS DOOR —
   * AND A DIFFERENT RECIPIENT SET DOES NOT GET THROUGH IT EITHER.
   *
   * The gateway's rule is that whether a write is encrypted is decided by the
   * stored object, and it enforces that by re-encrypting: the gateway holds a
   * workspace key and can open a `workspace`-recipient note itself, so it can
   * tell a legitimate re-encryption from a downgrade. This path cannot — the
   * control plane holds no key, by design, for either recipient kind — so for
   * a long time the only correct answer here was to refuse outright.
   *
   * A passphrase-locked note changed that, in one direction only. Its owner
   * derives the key **here**, on this device, and the console is the only
   * place a passphrase note can ever be edited, its passphrase changed, or its
   * lock removed — so a door that only ever emitted "no" made every one of
   * those unreachable as shipped. What is admitted is exactly what those flows
   * produce and nothing else: a submitted document that is *itself* a
   * well-formed envelope naming precisely the recipients already at this path.
   * `canReplaceEncryptedNote` is the whole of that check, and it is what keeps
   * this from being the second, weaker door onto the same bucket that the
   * gateway's stronger rule forbids — plaintext is refused exactly as before,
   * and so is any envelope that adds, drops or swaps a recipient, which is the
   * shape a downgrade or a mismatched context would take. What this door does
   * not and cannot check — because it holds no key — is whether the ciphertext
   * itself decrypts to anything: that is bounded by the same write authority
   * this caller already has over every other note at this path, not by
   * encryption, which `docs/decisions/encryption.md` is explicit is
   * confidentiality and not access control.
   *
   * Removing a passphrase lock is deliberately **not** reachable here at any
   * recipient set: this door never accepts plaintext over an encrypted note.
   * `removeNoteEncryption` is the separate, narrower door for that, reachable
   * only from an explicit action — never from an ordinary Save.
   *
   * Checked on the marker rather than on a parse, so a malformed *existing*
   * envelope is refused too — that is the case where overwriting is least
   * recoverable, and `canReplaceEncryptedNote` answers `false` for it because
   * a stored envelope it cannot parse can never equal anything.
   *
   * Before the conflict checks on purpose: this is a property of the note, not
   * of the etag, and answering `CONFLICT` first would tell somebody to reload
   * and try again at a write that can never succeed.
   */
  const existingText = existing !== null ? await existing.text() : null;
  if (existing !== null) {
    if (isEncryptedNote(existingText!) && !canReplaceEncryptedNote(existingText!, options.text)) {
      throw new FileOpError(
        "NOTE_ENCRYPTED",
        "That note is encrypted. Its content is stored as ciphertext and can only be edited through a client that can decrypt it.",
        existing.etag,
      );
    }
  }

  let collaborationResult: {
    documentId: string;
    update: string;
    text: string;
    etag: string;
  } | null = null;
  let sealedResult: { etag: string; bytes: number } | null = null;
  if (
    existing !== null &&
    !isEncryptedNote(existingText!) &&
    collaborationSupported(store)
  ) {
    if (collaborationEligible(path, existingText!) && options.expectedEtag !== undefined) {
      try {
        const base = await readCollaborationDocument(store, path);
        if (isEncryptedNote(options.text)) {
          const sealed = await sealCollaborationDocument(store, path, {
            documentId: base.documentId,
            expectedEtag: options.expectedEtag,
            text: options.text,
          });
          sealedResult = { etag: sealed.etag, bytes: byteLength(options.text) };
        } else {
          collaborationResult = await replaceCollaborationText(store, path, {
            documentId: base.documentId,
            expectedEtag: options.expectedEtag,
            text: options.text,
          });
        }
      } catch (error) {
        // An old/raw or forged base is still the ordinary stale-save conflict
        // at this API boundary. Do not turn it into STORAGE_FAILED merely
        // because the collaboration engine has a more precise internal code.
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (["BASE_MISSING", "CONFLICT", "GENERATION_MISMATCH", "SEAL_CONFLICT", "CONCURRENT_WRITE"].includes(code)) {
          throw new FileOpError(
            "CONFLICT",
            "That file changed somewhere else while you were editing it.",
            existing.etag,
          );
        }
        if (code === "UNSUPPORTED_STORAGE" || code === "STORAGE_WRITE_FAILED" || code === "CORRUPT_STATE") {
          throw new FileOpError(
            "STORAGE_UNSAFE",
            "This note cannot be saved safely for collaborative editing.",
            existing.etag,
          );
        }
        throw error;
      }
    }
  }

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
  } else if (!collaborationResult && !sealedResult && existing.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      existing.etag,
    );
  }

  // The version being replaced is not copied anywhere. Object versioning at the
  // provider is what keeps it, and it is the customer's to enable on a bucket
  // they own — see docs/decisions/storage-and-credentials.md. With it off, this
  // overwrite is final, and the console says so before it runs.
  const conditional = store.capabilities?.conditionalWrite === true && existing !== null;
  /*
   * A CREATE IS CONDITIONAL TOO, WHERE THE BUCKET HAS PROVEN IT CAN BE.
   *
   * The read above found nothing, and until this was added the put that
   * followed was unconditional — so a note created at the same path in the
   * round trip between them (an Obsidian sync, an AI client, a second device
   * draining its own offline queue) was overwritten with no error. Offline
   * made that window hours wide: a "new note" typed on a train is sent when
   * the train comes out of the tunnel, and whatever landed at that path in
   * between is exactly what it would have clobbered.
   *
   * `onlyIf: { absent: true }` is `If-None-Match: *`, which is a different
   * feature from `If-Match` and is probed separately, as `conditionalCreate`.
   * A bucket that honours one need not honour the other, so this asks for the
   * capability it is about to rely on and not its neighbour. Where it is not
   * proven the read above is the check, its one-round-trip race is what the
   * `read-compare` in the result reports, and nothing is sent that the bucket
   * might accept and ignore — `importVaultFiles` gives the same reasoning.
   */
  const conditionalCreate =
    existing === null && store.capabilities?.conditionalCreate === true;
  const put = sealedResult
    ? { etag: sealedResult.etag }
    : collaborationResult
    ? { etag: collaborationResult.etag }
    : conditional
      ? await store.put(path, options.text, { onlyIf: { etagMatches: existing!.etag } })
      : conditionalCreate
        ? await store.put(path, options.text, { onlyIf: { absent: true } })
        : await store.put(path, options.text);

  if (put === null) {
    // The backend rejected the precondition: somebody wrote between our read
    // and our put. Exactly the case conditional writes exist for — and for a
    // create it is the same `CONFLICT` a create onto an existing file gets
    // above, with the etag of what is there now.
    const current = await store.get(path);
    throw new FileOpError(
      "CONFLICT",
      existing === null
        ? "A file already exists at that path. Reload to see it."
        : "That file changed somewhere else while you were editing it.",
      current?.etag,
    );
  }

  return {
    path,
    etag: put.etag,
    bytes: sealedResult?.bytes ?? byteLength(collaborationResult?.text ?? options.text),
    conflictCheck: conditional || conditionalCreate ? "conditional" : "read-compare",
  };
}

/**
 * Replace an encrypted note's content with plaintext.
 *
 * `writeFile`'s widening lets an envelope replace an envelope naming the same
 * recipients — an edit, a passphrase change — and refuses plaintext over an
 * encrypted note in every case, on purpose: a person who merely re-saves what
 * they had loaded must never silently turn a passphrase lock off. Removing one
 * is therefore a separate, narrower door rather than a wider version of that
 * one, reachable only from an explicit "Remove encryption" action in the
 * console — never from the ordinary Save button, and never as a side effect of
 * `writeFile` accepting a plaintext body.
 *
 * **What this can and cannot verify.** The control plane holds no passphrase
 * and no key — it cannot check that `options.text` really is what the stored
 * envelope decrypts to, any more than `writeFile`'s widening can check that an
 * accepted envelope actually re-encrypts the same content. What stands in for
 * that is the same authority every other write at this path already carries:
 * `canSee` and a matching etag. `docs/decisions/encryption.md` is explicit that
 * this is the right boundary — "Encryption is confidentiality, and it is not
 * access control" — so a caller who could already overwrite this note's bytes
 * with garbage before it was locked can still overwrite them after, and the
 * one thing this function refuses that `writeFile` would not have to is a
 * replacement that is *itself* still an encrypted note: accepting one here
 * would reopen exactly the recipient-set hole `writeFile`'s own guard exists to
 * close, wearing this door's name instead.
 */
export async function removeNoteEncryption(
  store: FileStore,
  options: {
    path: string;
    text: string;
    expectedEtag?: string;
    clearance: Clearance;
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
  // Refused before anything else is even read: a replacement that is itself an
  // encrypted note is not a removal, whatever recipients it names, and letting
  // it through here would be the second, weaker door `writeFile`'s widening was
  // built not to open.
  if (isEncryptedNote(options.text)) {
    throw new FileOpError(
      "NOTE_ENCRYPTED",
      "That replacement is itself an encrypted note. Removing encryption writes plain Markdown — use an ordinary save to replace one encrypted note with another.",
    );
  }

  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const existing = await store.get(path);
  if (existing === null) throw notFound();
  const existingText = await existing.text();
  if (!isEncryptedNote(existingText)) {
    throw new FileOpError(
      "NOTE_NOT_ENCRYPTED",
      "That note is not encrypted; save it the ordinary way.",
      existing.etag,
    );
  }

  // Unlike `writeFile`, there is no "this is new" reading of a missing etag:
  // removal only ever acts on a note that is already there, so an absent
  // `expectedEtag` can only mean the caller never read the version it is about
  // to replace.
  if (options.expectedEtag === undefined) {
    throw new FileOpError(
      "CONFLICT",
      "Removing encryption has to be checked against the version you read. Re-read the note and try again.",
    );
  }
  if (existing.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      existing.etag,
    );
  }

  const conditional = store.capabilities?.conditionalWrite === true;
  const put = conditional
    ? await store.put(path, options.text, { onlyIf: { etagMatches: existing.etag } })
    : await store.put(path, options.text);

  if (put === null) {
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
    bytes: byteLength(options.text),
    conflictCheck: conditional ? "conditional" : "read-compare",
  };
}

/** Refuse the paths that are not notes, before anything else happens. */
function assertWritablePath(path: string): void {
  // Folded, so the manifest refusal is a decision rather than a side effect of
  // `isPlumbing` two lines below answering PATH_INVALID for the wrong reason.
  if (foldPath(path) === PRIVACY_KEY) {
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
 * What lands in a folder the moment it is made.
 *
 * S3 has no folders — a folder is a shared key prefix — so an "empty folder"
 * can only exist in a UI's memory unless something is written. Rather than
 * invent a hidden marker object (a dot-prefixed key is plumbing and would be
 * invisible to the very tools this is for), a new folder gets a `README.md`,
 * exactly as the PARA scaffold does. The folder is then real for Obsidian,
 * rclone, the gateway and everything else that reads the bucket.
 *
 * **It says it is a placeholder, because it is one.** It used to be `# <name>`
 * — the shape of a note somebody had started writing, on a file nobody wrote,
 * at the top of every folder they made. A person who opened it found an empty
 * overview page they had not asked for and could not tell whether they were
 * supposed to fill in. So the body names itself and says why it is there, which
 * is the only thing it knows. The console does not list it at all
 * (`isFolderPlaceholder`); this text is for the tools that do.
 *
 * `renderFolderPlaceholder` is exported so the copy is pinned by a test rather
 * than being a string literal nobody would notice changing.
 */
export function renderFolderPlaceholder(folder: string): string {
  return [
    "Folder placeholder.",
    "",
    `Object storage has no empty folders, so this file is what makes ${folder}/`,
    "exist. Context does not list it; Obsidian and anything else that reads your",
    "bucket will. Delete it once the folder holds something else, or write in it —",
    "it is an ordinary note.",
    "",
  ].join("\n");
}

/**
 * Create a folder — which means writing the one key that makes its prefix
 * exist. See `renderFolderPlaceholder` for what that key holds and why.
 */
export async function createFolder(
  store: FileStore,
  options: { path: string; clearance: Clearance; now: number },
): Promise<{ path: string; readme: string }> {
  const folder = requirePath(options.path);
  if (isPlumbing(folder)) {
    throw new FileOpError(
      "PATH_INVALID",
      "Paths beginning with a dot are reserved for history and audit.",
    );
  }
  // A caller who cannot see this folder must not be told it is there.
  // `store.get` below is a raw bucket read, so without this the collision
  // check answers "that folder already exists" for a folder `listFolder`
  // refuses to admit exists — and because every name that is *not* there
  // answers `notFound()`, that reply is a confirmed hit rather than a hint.
  // Guessable names over somebody's private half is the whole attack.
  //
  // Refusal itself is uniform: an explicit `private` rule and no rule at all
  // both answer `notFound()`, so it is not the refusal that discloses. What
  // remains is that *success* still means a team rule reaches this path —
  // the same residual `writeFile` has, and one `listFolder` already exposes
  // by returning an empty listing rather than `notFound()` there.
  const state = await loadPrivacyState(store);
  if (!folderVisibleAtScope(folder, options.clearance, state.rules, state.overrides)) {
    throw notFound();
  }

  const readme = joinPath(folder, "README.md");
  const existing = await store.get(readme);
  if (existing !== null) {
    throw new FileOpError("DESTINATION_EXISTS", "That folder already exists.");
  }
  await writeFile(store, {
    path: readme,
    text: renderFolderPlaceholder(folder),
    clearance: options.clearance,
    now: options.now,
  });
  return { path: folder, readme };
}

/**
 * Every immediate child name under a folder, visible or not.
 *
 * A short answer here is not a smaller answer, it is a wrong one: the name
 * `duplicateName` picks from it is refused by `copyPath`'s guard if a hidden
 * note holds it, and Duplicate then says "that file does not exist" if and only
 * if one does. Reproduced against a store whose page dropped the earlier key.
 *
 * So it refuses rather than truncating, which is what `keysUnder` and
 * `namesExtending` do and what `listFolder` and `rootFolders` report. This is
 * the fifth listing walk in this file and the second time I have written one
 * that inferred its own completeness — the first was `namesExtending`, three
 * functions away, in the commit whose subject was that mistake.
 */
async function namesInUse(store: FileStore, folder: string): Promise<Set<string>> {
  const prefix = folder === "" ? "" : `${folder}/`;
  const names = new Set<string>();
  let cursor: string | undefined;
  let complete = false;
  let stop: WalkStop = "budget";
  const seen = new Set<string>();
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (object.key !== prefix) names.add(baseName(object.key));
    }
    // Subfolder names count: a folder called `note copy.md` takes that name as
    // surely as a note does, and landing a file key beside a folder prefix is
    // the shape `movePath` refuses as unrepresentable on a Dropbox binding.
    for (const raw of listing.delimitedPrefixes ?? []) {
      names.add(baseName(raw.replace(/\/+$/, "")));
    }
    // Truncated-with-no-cursor is not finished, it is unable to continue — see
    // `listFolder`. Folding the two into one `||` set `complete` on a short
    // walk, which is the row-83 defect reachable a second way.
    if (!listing.truncated) {
      complete = true;
      break;
    }
    if (!listing.cursor) {
      stop = "store";
      break;
    }
    if (seen.has(listing.cursor)) {
      stop = "store";
      break;
    }
    seen.add(listing.cursor);
    cursor = listing.cursor;
  }
  if (!complete) {
    throw walkStopped(
      stop,
      "That folder holds too many files to duplicate into safely. Move some of them first.",
    );
  }
  return names;
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

/**
 * Why a bounded walk stopped short — which is not one question but two, and
 * they need different answers.
 *
 * "Too many files" is about the customer's folder, and splitting it is a real
 * remedy. A store that says `IsTruncated: true` and then offers no continuation
 * token, or replays one it already gave, is about their storage endpoint: the
 * folder may hold three files, and splitting it will never produce the token,
 * so `FOLDER_TOO_LARGE` sends them round a remedy that cannot terminate. One
 * code told them the wrong thing in the second case, which is a smaller version
 * of the same habit as reporting a floor as a total — the message has to admit
 * what actually happened.
 */
type WalkStop = "budget" | "store";

function walkStopped(stop: WalkStop, tooLarge: string): FileOpError {
  return stop === "budget"
    ? new FileOpError("FOLDER_TOO_LARGE", tooLarge)
    : new FileOpError(
        "LISTING_INCOMPLETE",
        "Your storage provider did not return the whole folder listing, so nothing was changed. That is the bucket's endpoint rather than the folder — retrying may help; splitting the folder will not.",
      );
}

/**
 * Every key under a folder *this caller can see*, capped. Move, copy and
 * delete all walk it.
 *
 * The filter is the whole point and it was missing. Without it a bulk
 * operation acts on keys its caller cannot see and then names them in its
 * result: an editor deleting a shared folder permanently destroyed the
 * owner's private note inside it, purged its `.history/` too, and was handed
 * the note's path in the return value.
 *
 * **Filtered rather than refused**, which is the part that is not obvious.
 * Refusing an operation because the tree holds something invisible reports
 * that the invisible thing is there — a caller could separate "folder I can
 * move" from "folder with a private note in it" from "folder that does not
 * exist" and localise every private note to its folder without reading one.
 * The gateway settled this for `move_folder` and wrote out the reasoning; this
 * is the same decision in the control plane, so the two halves of the product
 * answer alike. A folder holding nothing visible yields no keys, and every
 * caller here turns that into the same `notFound()` a missing folder gets.
 */
async function keysUnder(
  store: FileStore,
  folder: string,
  clearance: Clearance,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): Promise<{ keys: string[]; withheld: string[] }> {
  const prefix = `${folder}/`;
  const keys: string[] = [];
  // What was held back, which two callers need for different reasons: the
  // manifest bookkeeping must know *whether* anything was, and the history
  // purge must know *which*, so it does not sweep a survivor's snapshots.
  // Returned rather than recorded anywhere outside this call: Workers and
  // Convex reuse isolates, so a module-level flag would be one request telling
  // the next one what it saw.
  const withheld: string[] = [];
  // Whether the walk reached the end of the folder. `listFolder` reports the
  // same thing as `truncated` and `resetPrivacyManifest` as `partial`; this one
  // used to just fall out of the loop, so a folder deeper than the page cap
  // returned a short list that read exactly like a complete one — and the
  // manifest bookkeeping below rewrites rules on the strength of it.
  let complete = false;
  let stop: WalkStop = "budget";
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (isPlumbing(object.key)) continue;
      if (!canSee(object.key, clearance.scope, rules, overrides, clearance.names)) {
        withheld.push(object.key);
        continue;
      }
      keys.push(object.key);
      if (keys.length > FOLDER_OPERATION_CAP) {
        throw new FileOpError(
          "FOLDER_TOO_LARGE",
          `That folder holds more than ${FOLDER_OPERATION_CAP} files. Move or delete it in smaller pieces.`,
        );
      }
    }
    // Truncated-with-no-cursor is not finished, it is unable to continue — see
    // `listFolder`. Folding the two into one `||` set `complete` on a short
    // walk, which is the row-83 defect reachable a second way.
    if (!listing.truncated) {
      complete = true;
      break;
    }
    if (!listing.cursor) {
      stop = "store";
      break;
    }
    // A store that repeats a cursor will never finish, and the page budget
    // would spend itself before saying so. Comparing against the previous
    // cursor alone is defeated by a store alternating two of them, so this
    // keeps the set - which is what the gateway's `nextListCursor` does.
    if (seen.has(listing.cursor)) {
      stop = "store";
      break;
    }
    seen.add(listing.cursor);
    cursor = listing.cursor;
  }
  // Refused rather than truncated, which is what the gateway's own listing
  // helper does ("refusing to loop"). A partial walk cannot be operated on
  // safely: it moves some of a folder while the manifest is rewritten as
  // though all of it went, and nothing downstream can tell.
  if (!complete) {
    throw walkStopped(
      stop,
      "That folder holds too many files to move or delete in one go. Do it in smaller pieces.",
    );
  }
  return { keys, withheld };
}

/**
 * Live notes whose key extends this one's, which a file delete must not sweep.
 *
 * `a.md.notes.md` is an ordinary note and its snapshots begin with
 * `.history/a.md.`, so deleting `a.md` reached them. These are survivors in
 * exactly the sense the folder walk means, so they travel the same way.
 */
async function namesExtending(store: FileStore, path: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let complete = false;
  let stop: WalkStop = "budget";
  const seen = new Set<string>();
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: `${path}.`, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (object.key === path || isPlumbing(object.key)) continue;
      keys.push(object.key);
    }
    // Truncated-with-no-cursor is not finished, it is unable to continue — see
    // `listFolder`. Folding the two into one `||` set `complete` on a short
    // walk, which is the row-83 defect reachable a second way.
    if (!listing.truncated) {
      complete = true;
      break;
    }
    if (!listing.cursor) {
      stop = "store";
      break;
    }
    if (seen.has(listing.cursor)) {
      stop = "store";
      break;
    }
    seen.add(listing.cursor);
    cursor = listing.cursor;
  }
  // One `list` with a limit and no cursor was the first version of this, added
  // in the same change that stopped `keysUnder` inferring completeness — the
  // same mistake, three functions apart. A short answer here silently drops a
  // survivor, and a dropped survivor has its history swept.
  if (!complete) {
    throw walkStopped(
      stop,
      "Too many files share that name for it to be deleted safely. Rename or remove some of them first.",
    );
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
 * **Matched by prefix, not by parsing the stamp.** Nothing writes these any
 * more, but every bucket connected before that holds them in five spellings
 * (`.md`, `.move.md`, `.archive.md`, `.batch-move.md`, `.inbox.md`) written by
 * four functions that no longer exist. That is the argument for prefix matching
 * rather than against it: the writers are gone, so a regex can only be checked
 * against buckets nobody can re-create. A regex that had to stay in sync would fail
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
  /**
   * The notes actually deleted, or `null` to sweep the whole subtree.
   *
   * `null` is the owner's case and keeps the original behaviour exactly,
   * orphaned snapshots included — a folder's history is theirs and the promise
   * that nothing survives a permanent delete is the point of this function.
   *
   * A team caller now deletes only what they could see, so sweeping the whole
   * subtree would destroy the history of the private notes they left standing.
   * The live note surviving while every version of it is purged is the same
   * data loss wearing a smaller number.
   */
  deleted: readonly string[] | null,
  /**
   * Notes left standing, whose snapshots must survive with them.
   *
   * The prefix match above is deliberately not a parse, and its stated cost was
   * that it "can over-match another note's — equally unreachable — plumbing,
   * which would need a note literally named `<this note>.something.md`". That
   * was true while the whole folder went, because the over-matched note was
   * being deleted too. Once a caller deletes only part of a folder it is false:
   * `a.md.notes.md` survives and `.history/a.md.notes.md.<stamp>.md` begins
   * with `.history/a.md.`, so deleting `a.md` took every version of a note it
   * did not delete.
   *
   * Answered with the survivors themselves rather than a stamp regex. A regex
   * would have to track five snapshot spellings across two apps and would fail
   * silently in the wrong direction; this cannot drift, because it compares
   * against real keys.
   *
   * **A single-file delete has survivors too**, which the first version of this
   * missed by only thinking about folders: deleting `a.md` matched
   * `.history/a.md.notes.md.<stamp>.md`, and `a.md.notes.md` is a live note
   * nobody asked to delete. That one is older than the filtering — it is true
   * on `main` — and it is the same sentence being false, so it is fixed here
   * rather than left with a comment that describes only half of it.
   */
  survivors: readonly string[],
): Promise<string[]> {
  // A folder's history mirrors its shape (`.history/1-projects/note.md.<stamp>.md`),
  // so the whole subtree goes. A file's history is the siblings sharing its name.
  const keys: string[] = [];
  const currentPrefix = pathIsFolder ? `${HISTORY_PREFIX}${path}/` : `${HISTORY_PREFIX}${path}.`;
  const storagePrefixes = [currentPrefix, legacyStorageKey(currentPrefix)].filter(
    (value): value is string => Boolean(value),
  );
  for (const prefix of storagePrefixes) {
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      const listing = await store.list({ prefix, cursor, limit: 1000 });
      for (const object of listing.objects ?? []) {
        const logicalKey = `${currentPrefix}${object.key.slice(prefix.length)}`;
        // For a file, a `/` in the tail would mean a directory we did not put
        // there — leave it rather than sweep something we cannot explain.
        if (!(pathIsFolder || !object.key.slice(prefix.length).includes("/"))) continue;
        if (deleted !== null) {
          // Which note does this snapshot belong to? `.history/a.md.X.md` could
          // be a version of `a.md` stamped `X`, or of a note actually called
          // `a.md.X` — a prefix test cannot tell, and testing the deleted set and
          // the survivors separately gets it wrong in both directions at once:
          // `a.md` shields `a.md.notes.md`'s snapshots from a delete that took
          // it, and `a.md.notes.md` is swept by a delete of `a.md`.
          //
          // Longest match decides, the same way `visibilityOf` resolves a key
          // against overlapping folder rules. The snapshot belongs to the most
          // specific note whose name it extends, and it goes only if that note
          // is one of the ones actually deleted.
          let owner: string | null = null;
          for (const key of [...deleted, ...survivors]) {
            if (!logicalKey.startsWith(`${HISTORY_PREFIX}${key}.`)) continue;
            if (owner === null || key.length > owner.length) owner = key;
          }
          if (owner === null || !deleted.includes(owner)) continue;
        }
        keys.push(object.key);
      }
      // The one walk with nowhere to put the answer. Its only caller has already
      // deleted the live keys by the time it runs, so it cannot refuse, and
      // `DeleteResult` carries only `paths` — there is no `truncated` to report
      // through. A short walk here leaves snapshots of a note somebody
      // permanently deleted, which is the lie the delete copy must not tell.
      //
      // Already reachable at `LIST_PAGE_CAP`, and the fold below does not widen
      // it as much as it looks: on a store that misreports consistently,
      // `deletePath` never gets this far, because `keysUnder` (folder) or
      // `namesExtending` (file) refuses first. What is left needs a store that
      // misbehaves only under `.history/`, or only sometimes — narrow, but not
      // nothing, and stating "not made worse" flatly would be the overclaim.
      // Left as it is rather than papered over: the fix is to resolve the history
      // before the live keys go, which is a bigger change than this one.
      if (!listing.truncated || !listing.cursor) break;
      cursor = listing.cursor;
    }
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
  /** What the link rewrite did. See `rewriteReferences`. */
  references?: ReferenceRewrite;
  /**
   * The moved note's etag at its new path — a single note only, and only where
   * the bucket answered the write with one. See `movePath`.
   */
  etag?: string;
}

export interface ReferenceRewrite {
  /** Notes whose bodies were changed. */
  notes: number;
  /** Link targets moved across those notes. */
  links: number;
  /** The context was too large to walk, so nothing was rewritten. */
  capped: boolean;
}

/**
 * May this caller write here, and be told what is already here?
 *
 * The gateway's `move_note` asks exactly this, in exactly this way, and three
 * earlier answers on this branch were wrong in three different directions:
 *
 *  - `canSee(destination)` alone. A move carries the source's exception onto
 *    the destination so the note keeps its visibility, which made the check
 *    true for ANY destination — a note the owner had shared out of a private
 *    folder was a key that opened every folder.
 *  - `canSee` plus `folderVisibleAtScope(parentOf(destination))`.
 *    `folderVisibleAtScope` answers "should this folder appear in the tree",
 *    and it says yes when ANY `team` exception exists anywhere beneath it —
 *    that is its documented job, so a folder is reachable in the tree the
 *    moment one note in it is shared. Reusing it as a write predicate reopened
 *    the whole subtree: one shared note under `2-areas/deep/sub/` made every
 *    path under `2-areas/` probeable again.
 *  - And it skipped the bucket root entirely, because `parentOf` returns `""`
 *    there and the check was guarded on that. The root is where `index.md`,
 *    `privacy.md` and `todo.md` live; a team caller could probe them and, on a
 *    bucket without one, create `index.md` — the front page the product says it
 *    never generates.
 *
 * So the question is asked of the destination path itself, against the folder
 * defaults as they will stand, and it has one answer at the root as everywhere
 * else: no rule reaches it, so it is private, so a team caller may not land
 * there. `visibilityOf` rather than `effectiveVisibility` because an exception
 * is about one note and this is about a place — and a destination that already
 * carries an exception is refused outright, so a caller can never land on a
 * note whose visibility is unusual, nor learn from the attempt that it is.
 *
 * The cost, which is a real behaviour change: a team caller can no longer move
 * or rename a shared note that lives inside a private folder, because the place
 * it would land is private even though the note is not. The gateway has always
 * refused that, and every time this branch has diverged from the gateway it has
 * been the branch that was wrong.
 */
function assertDestinationsVisible(
  destinations: readonly string[],
  clearance: Clearance,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): void {
  for (const destination of destinations) {
    if (clearance.scope === "private") continue;
    // The place, then the note that may already be in it.
    //
    // `visibilityOf` and not `effectiveVisibility`: they differ only when the
    // destination carries an exception, and the line below refuses that case
    // outright — so swapping them changes no outcome, which is measured rather
    // than assumed. They are kept apart because they answer different
    // questions, and the second is what stops a caller landing on a note whose
    // visibility is unusual.
    //
    // It does NOT stop them learning that one is there. A refusal where a free
    // name would have succeeded says an exception exists at that path, and that
    // is inherent to per-note exceptions rather than a hole here: `writeFile`
    // has the same shape and says so, and the gateway's `move_note` has it too.
    // An earlier version of this comment claimed otherwise. What is bounded is
    // the folder: the line above means a caller can only learn this about
    // places they may already write.
    //
    // No plumbing check: `assertWritablePath` has already refused a reserved
    // `to`, and every destination is `to` plus a suffix taken from a source key
    // the walk kept, which filtered plumbing out. A dot segment cannot appear.
    // Instrumented before this was written, rather than after.
    if (visibilityOf(destination, rules) !== "team") throw notFound();
    if (hasOverride(overrides, destination)) throw notFound();
  }
}

/**
 * The same question, asked of the manifest as it stands.
 *
 * This used to be asked of the rules the move would LEAVE BEHIND, so that a
 * folder carrying its own `team` rule could be renamed inside a private parent
 * — the rule travels, so the caller can still see the result. That reasoning is
 * wrong in the one way this file has now been wrong four times: the predicate
 * was satisfied by the rule the move itself installs. A guard that reads its
 * own seeding answers on the strength of the thing being asked about, which is
 * exactly what the comment on `assertDestinationsVisible` said had been
 * eliminated — for the overrides, while the rules kept doing it.
 *
 * What it cost: a team caller holding one shared folder could move it at any
 * hidden path and read the answer. An existing folder they could not see
 * refused; a free name succeeded. One guess at a time over the owner's entire
 * hidden namespace — and on success the move landed, `remapPrivacy` wrote
 * `<their guess>: team` into `privacy.md`, and an EDITOR had thereby set folder
 * visibility inside the owner's private tree, which `setFolderVisibility`
 * reserves to the owner.
 *
 * The benign rename and the hostile probe are the same operation with a
 * different name typed into it, so no predicate separates them. The rename goes.
 * The gateway's `move_folder` has always judged the destination against current
 * rules and has never renamed a folder rule.
 */
function assertMoveDestinationsVisible(
  pairs: readonly { source: string; destination: string }[],
  clearance: Clearance,
  state: PrivacyState,
): void {
  assertDestinationsVisible(
    pairs.map((pair) => pair.destination),
    clearance,
    state.rules,
    state.overrides,
  );
}

/**
 * The rules a rewrite must put back, because a survivor's visibility rests on
 * them.
 *
 * A bulk operation at team scope leaves the notes it could not see behind, and
 * the rules under that folder then describe two places at once. Both blunt
 * answers are wrong: rewriting them all stops a nested rule protecting the note
 * it was written for — and because `visibilityOf` takes the longest matching
 * prefix, that does not demote the note to the default, it PROMOTES it to the
 * nearest surviving ancestor, which is the `team` folder the caller is standing
 * in. Keeping them all makes the kept rule its own disclosure.
 *
 * So: a rule comes back only where a survivor actually needs it, and "needs"
 * is asked of the REWRITE, not of the rule.
 *
 * The first version asked it of the rule — "would removing *this one* change a
 * survivor?" — one rule at a time. That is a different question and it fails
 * whenever two rules cover a survivor redundantly (`…/hr: private` and
 * `…/hr/comp: private`, which is what an owner who tightened a folder and then
 * a subfolder has). Removing either alone changes nothing, so neither was
 * needed, so BOTH were dropped and the note went to the team ancestor. A
 * per-element counterfactual cannot see a set effect; this compares the whole
 * before against the whole after, and repairs what actually moved.
 *
 * One pass suffices. A survivor whose visibility changed is repaired by the
 * rule that decided it *before* — the longest prefix matching it — and nothing
 * in the rewritten set can outrank that, because the rewritten rules live under
 * the destination and everything else covering a survivor is an ancestor, which
 * is shorter. Ties go to the first rule, matching `visibilityOf`.
 */
function rulesSurvivorsRestOn(
  before: readonly PrivacyRule[],
  after: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
  survivors: readonly string[],
  folder: string,
): PrivacyRule[] {
  if (survivors.length === 0) return [];
  // Narrowing, not a check. A rule outside this folder is already in `after`
  // untouched, so it can never be the one a survivor lost — dropping this
  // filter changes no outcome, which is measured rather than assumed. It stays
  // because it bounds the search to the rules this rewrite could have moved.
  const candidates = before.filter(
    (rule) => rule.prefix === folder || rule.prefix.startsWith(`${folder}/`),
  );
  if (candidates.length === 0) return [];

  const kept: PrivacyRule[] = [];
  for (const key of survivors) {
    if (
      effectiveVisibility(key, before, overrides) ===
      effectiveVisibility(key, [...after, ...kept], overrides)
    ) {
      continue;
    }
    let determining: PrivacyRule | null = null;
    for (const rule of candidates) {
      if (key !== rule.prefix && !key.startsWith(`${rule.prefix}/`)) continue;
      if (determining === null || rule.prefix.length > determining.prefix.length) {
        determining = rule;
      }
    }
    // Either of these alone is redundant given the other, and they are
    // load-bearing as a pair: the comparison above stops a second survivor
    // re-pushing a rule the first restored, and this stops a repeat when that
    // comparison is bypassed. Remove BOTH and the delete path emits the same
    // rule twice, because `forgetPrivacy` does not run `oneRulePerPrefix` and
    // nothing downstream tidies it. Measured both ways — do not read "each is
    // redundant" as "either may go".
    if (determining !== null && !kept.includes(determining)) kept.push(determining);
  }
  return kept;
}

/**
 * One rule per prefix, and the more private of a pair wins.
 *
 * A rename can land a rule on a prefix that already had one - move `src` onto
 * `dst` when `src/hr` and `dst/hr` both carry rules - and the manifest then
 * holds two lines for the same folder with opposite visibility. `visibilityOf`
 * takes the first of equal length and `renderPrivacyRulesBlock`'s sort is
 * stable, so whichever it is survives the round trip and the file says two
 * things at once. Measured: `1-projects/dst/hr` emitted as both `team` and
 * `private`.
 *
 * The collision has no right answer - the arriving folder and the one already
 * there both have a claim - so it is resolved in the only direction that
 * cannot leak: the narrower of the two survives.
 *
 * That used to be spelled `existing.vis === "team" && rule.vis === "private"`,
 * which was the same thing while there were two values and stopped being it
 * the day a rule could name a group. Nothing in that test narrows `team` to a
 * group, and nothing narrows a group to `private`, so renaming a folder whose
 * subfolder was held back to `@supa-leads` over one whose matching subfolder
 * was `team` kept `team` - every note under it readable by the whole
 * workspace, from a rename. `narrowerVisibility` is the engine's own order and
 * is identical to the old test on the two tiers.
 */
function oneRulePerPrefix(rules: readonly PrivacyRule[]): PrivacyRule[] {
  const byPrefix = new Map<string, PrivacyRule>();
  for (const rule of rules) {
    const existing = byPrefix.get(rule.prefix);
    if (existing === undefined) {
      byPrefix.set(rule.prefix, rule);
      continue;
    }
    const narrower = narrowerVisibility(existing.vis, rule.vis);
    // Keep the rule object whose value won, and prefer the incumbent on a tie
    // so the pass stays stable. Two different groups narrow to `private`, which
    // is neither rule's object - it is written as a fresh one rather than
    // dropped, because "neither claim survives" must still leave a rule.
    if (narrower === existing.vis) continue;
    byPrefix.set(rule.prefix, narrower === rule.vis ? rule : { prefix: rule.prefix, vis: narrower as Visibility });
  }
  return [...byPrefix.values()];
}

/** The folder rules a folder move leaves behind. `remapPrivacy` applies this. */
function rulesAfterFolderMove(
  rules: readonly PrivacyRule[],
  folderMove: { from: string; to: string } | null,
): readonly PrivacyRule[] {
  if (folderMove === null) return rules;
  const { from, to } = folderMove;
  return rules.map((rule) =>
    rule.prefix === from || rule.prefix.startsWith(`${from}/`)
      ? { prefix: `${to}${rule.prefix.slice(from.length)}`, vis: rule.vis }
      : rule,
  );
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
  options: {
    from: string;
    to: string;
    clearance: Clearance;
    now: number;
    /**
     * The version of the note this move was asked about. Given, the move is
     * refused with `CONFLICT` and the current etag when the note is anywhere
     * else — the same answer a queued edit gets, for the same reason: a rename
     * typed offline is a decision about the note as it was then. Absent is an
     * online press made while looking at the listing, exactly as before.
     *
     * A note only: a folder has no version to name.
     */
    expectedEtag?: string;
    /**
     * Refuse, rather than read-compare, where the bucket cannot make the check
     * atomic. The plugin runtime asks for this — a plugin renames as part of a
     * transaction it cannot see the end of. A person's queued rename does not:
     * it gets the check an online save gets on the same bucket.
     */
    requireAtomic?: boolean;
  },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(from);
  assertWritablePath(to);
  if (from === to) return { from, to, paths: [] };
  if (to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be moved inside itself.");
  }
  // ...nor onto one of its own ancestors, which is a rename that flattens a
  // folder into a parent it is already inside. It also breaks the one thing
  // that makes the manifest repair below sound: a renamed rule normally lands
  // under the destination, where it cannot outrank a rule kept under the
  // source. When the destination IS an ancestor the two trees overlap, and a
  // renamed `.../b/b/hr/deep: team` came out longer than the `.../b/hr: private`
  // put back for a survivor, which published it.
  if (from.startsWith(`${to}/`)) {
    throw new FileOpError(
      "PATH_INVALID",
      "A folder cannot be moved onto a folder it is already inside.",
    );
  }

  const state = await loadPrivacyState(store);
  if (!canSee(from, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  if (options.expectedEtag !== undefined && sourceIsFolder) {
    throw new FileOpError(
      "PATH_INVALID",
      options.requireAtomic === true
        ? "Plugins may only rename files, not folders."
        : "A folder has no version, so it cannot be moved against one.",
    );
  }
  /*
    Atomic where the bucket can do both halves conditionally — the copy
    `onlyIf: { absent }` and the delete `onlyIf: { etagMatches }` — and a
    read-compare where it cannot: the source's etag is compared just before it
    is copied, which is what an online save on such a bucket gets too. Only the
    plugin runtime refuses the second kind.
  */
  const atomic =
    options.expectedEtag !== undefined &&
    store.capabilities?.conditionalCreate === true &&
    store.capabilities?.conditionalDelete === true;
  if (options.expectedEtag !== undefined && options.requireAtomic === true && !atomic) {
    throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely rename plugin files.");
  }
  const changedElsewhere =
    options.requireAtomic === true
      ? "That file changed somewhere else while the plugin was using it."
      : "That note changed somewhere else after this was asked for.";

  // The header of this function says "the destination must not exist: this
  // never merges and never overwrites". That was true of files, which the
  // collision loop below checks key by key, and never true of folders — moving
  // `src` onto an existing `dst` merged them, and the rename carried `src`'s
  // folder rule onto `dst`, where it reached notes that were already there.
  // Measured: an owner's `dst/secret.md` went from hidden to readable for the
  // team caller who moved their own folder next to it.
  //
  // Refused with `notFound()` when the caller cannot see the folder, which is
  // the shape `createFolder`'s collision check already uses and the reason it
  // uses it: "that folder already exists" about a folder they cannot list is
  // the disclosure, not the merge.
  // "The destination must not exist" is about a destination of either kind. The
  // collision loop below checks key against key, so a file onto a file was
  // always caught; a folder onto a folder merged, and the two crossed pairs
  // left a file key shadowing a folder prefix — a shape a Dropbox binding
  // cannot even represent.
  if (await isFolder(store, to)) {
    if (!folderVisibleAtScope(to, options.clearance, state.rules, state.overrides)) throw notFound();
    throw new FileOpError(
      "DESTINATION_EXISTS",
      sourceIsFolder
        ? "That folder already exists. Moving one folder onto another would merge them."
        : "A folder already exists at that path.",
    );
  }
  if (sourceIsFolder && (await store.get(to)) !== null) {
    if (!canSee(to, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
    throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
  }

  const walk = sourceIsFolder
    ? await keysUnder(store, from, options.clearance, state.rules, state.overrides)
    : { keys: [from], withheld: [] };
  const sources = walk.keys;
  if (!sourceIsFolder && (await store.get(from)) === null) throw notFound();
  if (sources.length === 0) throw notFound();

  const folderMove = sourceIsFolder ? { from, to } : null;

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  assertMoveDestinationsVisible(pairs, options.clearance, state);

  // A plaintext Markdown note on a supported bucket is owned by the
  // collaboration head once it is opened. Preserve that identity through a
  // rename instead of copying its materialization and leaving the head at the
  // old path. Folders and ineligible files continue through the structural
  // legacy path because the engine intentionally only names individual notes.
  if (!sourceIsFolder && collaborationSupported(store)) {
    const sourceObject = await store.get(from);
    if (sourceObject !== null) {
      const sourceText = await sourceObject.text();
      if (!isEncryptedNote(sourceText) && collaborationEligible(from, sourceText)) {
        if (store.capabilities?.conditionalDelete !== true) {
          throw new FileOpError(
            "STORAGE_UNSAFE",
            "This storage cannot safely move a collaboratively edited note.",
          );
        }
        if ((await store.get(to)) !== null) {
          throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
        }
        const destinationVisibility = narrowerVisibility(
          effectiveVisibility(from, state.rules, state.overrides),
          visibilityOf(to, state.rules),
        );
        // Install any narrowing before moveDocument materializes bytes at the
        // destination. The source rule remains in place until remapPrivacy
        // runs after success; on failure a stale narrowing is safe to leave.
        if (destinationVisibility !== "team") {
          await mutateManifest(store, (current) => ({
            rules: current.rules,
            overrides: nextOverrides(
              to,
              narrowerVisibility(
                destinationVisibility,
                effectiveVisibility(to, current.rules, current.overrides),
              ) ?? "private",
              current.rules,
              current.overrides,
            ),
          }));
        }
        let moved;
        try {
          moved = await moveCollaborationDocument(store, from, to, {
            ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
          });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
          if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
            throw new FileOpError("CONFLICT", changedElsewhere, sourceObject.etag);
          }
          if (code === "DESTINATION_EXISTS") throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
          if (code === "UNSUPPORTED_STORAGE") {
            throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely move a collaboratively edited note.");
          }
          throw error;
        }
        const movedPairs = [{ source: from, destination: to }];
        await remapPrivacy(store, {
          moves: [{ from, to }],
          folderMove: null,
          survivors: [],
        });
        await recordForwarding(store, [{ from, to, kind: "note" as const }], { now: options.now });
        let finalEtag = moved.etag;
        const references = await rewriteReferences(store, {
          clearance: options.clearance,
          state,
          renames: new Map(movedPairs.map((pair) => [pair.source, pair.destination])),
          onRewritten: (key, etag) => {
            if (key === to) finalEtag = etag;
          },
        });
        return {
          from,
          to,
          paths: [to],
          references,
          etag: finalEtag,
        };
      }
    }
  }

  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      // This message names the path back, which is safe only because the guard
      // above has established that the caller can see both the key and the
      // folder holding it. An earlier version of this comment claimed the guard
      // read "the same rules this loop reads" and that the line was therefore
      // unreachable with a hidden path. That was wrong, and instrumenting it is
      // what showed it: the guard seeds a carried exception into its override
      // map, so a note the owner had shared out of a private folder made any
      // destination pass, and this line then answered from the real manifest.
      // The folder check above is what actually closes it.
      //
      // "No test reaches it" was the evidence for the old claim, and it was the
      // wrong kind of evidence — the suite had no team-scope coverage of this
      // line at all. There is one now.
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `Something already exists at ${pair.destination}.`,
      );
    }
  }

  /*
    The etag the note has at its new path, for a single note. A queue that
    renamed a note and then deletes it offline sends the delete against *this*
    version — the one its own rename produced — and without it would have to
    either guess or drop the check.
  */
  let movedEtag: string | undefined;
  // Folder moves carry individual note heads. Move those notes through the
  // lifecycle first, and only use the byte-copy path for ineligible files.
  // Preflight the capability before the first pair so a provider without
  // conditional delete cannot leave a half-moved folder.
  const collaborativePairs = new Set<string>();
  if (sourceIsFolder && collaborationSupported(store)) {
    const candidates: Array<{
      pair: (typeof pairs)[number];
      visibility: Visibility;
    }> = [];
    for (const pair of pairs) {
      const object = await store.get(pair.source);
      if (object === null) continue;
      const text = await object.text();
      if (!isEncryptedNote(text) && collaborationEligible(pair.source, text)) {
        candidates.push({
          pair,
          visibility: narrowerVisibility(
            effectiveVisibility(pair.source, state.rules, state.overrides),
            visibilityOf(pair.destination, state.rules),
          ) ?? "private",
        });
      }
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely move collaboratively edited notes.");
    }
    if (candidates.length > 0) {
      await mutateManifest(store, (current) => {
        let next = current.overrides;
        for (const candidate of candidates) {
          if (candidate.visibility === "team") continue;
          next = nextOverrides(
            candidate.pair.destination,
            narrowerVisibility(
              candidate.visibility,
              effectiveVisibility(
                candidate.pair.destination,
                current.rules,
                next,
              ),
            ) ?? "private",
            current.rules,
            next,
          );
        }
        return { rules: current.rules, overrides: next };
      });
    }
    for (const candidate of candidates) {
      try {
        await moveCollaborationDocument(store, candidate.pair.source, candidate.pair.destination);
        collaborativePairs.add(candidate.pair.source);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
          throw new FileOpError("CONFLICT", "A note changed somewhere else while this folder was moving.");
        }
        if (code === "DESTINATION_EXISTS") throw new FileOpError("DESTINATION_EXISTS", "A destination changed while this folder was moving.");
        if (code === "UNSUPPORTED_STORAGE") throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely move collaboratively edited notes.");
        throw error;
      }
    }
  }

  for (const pair of pairs) {
    if (collaborativePairs.has(pair.source)) continue;
    const object = await store.get(pair.source);
    if (object === null) {
      // Vanished mid-move. Nothing to carry — unless this move was asked
      // against a version, and then the version it named is not there.
      if (options.expectedEtag !== undefined) throw new FileOpError("CONFLICT", changedElsewhere);
      continue;
    }
    if (options.expectedEtag !== undefined && object.etag !== options.expectedEtag) {
      throw new FileOpError("CONFLICT", changedElsewhere, object.etag);
    }
    const body = await object.text();
    const created = atomic
      ? await store.put(pair.destination, body, { onlyIf: { absent: true } })
      : await store.put(pair.destination, body);
    if (created === null) throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${pair.destination}.`);
    const removed = atomic
      ? await store.delete(pair.source, { onlyIf: { etagMatches: options.expectedEtag! } })
      : await store.delete(pair.source);
    if (removed === null) {
      if (created?.etag) await store.delete(pair.destination, { onlyIf: { etagMatches: created.etag } });
      throw new FileOpError("CONFLICT", changedElsewhere);
    }
    if (!sourceIsFolder && created?.etag) movedEtag = created.etag;
  }

  if (folderMove !== null) {
    /*
      The folder itself, on a backend that has one.

      `createFolder` writes down the assumption the rest of this file is built
      on — object storage has no folders, only shared key prefixes — and it is
      true of R2 and S3 and false of Dropbox. There the files move and the
      directory stays, `list` keeps reporting it as a prefix, and the console
      goes on drawing the folder somebody just moved. The notes at the new name
      and the old folder still beside them is a move that reads as a copy, and
      it read that way on exactly one backend.

      `keep` is the destination: moving a folder next to itself must not tidy
      away the tree the move just built. `walk.withheld` is why the adapter's
      own emptiness check is the authority rather than this list — a note this
      caller could not see is still in that folder, and the folder has to stay.
    */
    await pruneEmptyFolders(
      store,
      pairs.map((pair) => pair.source),
      { roots: [folderMove.from], keep: [folderMove.to] },
    );
  }

  await remapPrivacy(store, {
    moves: pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
    folderMove,
    survivors: walk.withheld,
  });

  /*
    A FORWARDING ADDRESS, FOR THE REFERENCES A REWRITE CANNOT REACH.

    `rewriteReferences` below fixes every link inside the bucket. It cannot
    touch the ones held elsewhere — a share link already sent, a deep link in
    somebody's chat log — so the move also records where things went. See
    `apps/mcp/src/forwarding.js` for why this is a trail between paths rather
    than an index of who points at what.

    **A folder move is one entry**, not one per file it carried: a nine
    thousand note rename must not write nine thousand rows, and a prefix rule
    forwards the whole subtree. It is the same engine the gateway records with,
    imported rather than ported, so a rename through the console and the same
    rename through an MCP client leave the same trail.
  */
  await recordForwarding(
    store,
    folderMove
      ? [{ from, to, kind: "folder" as const }]
      : pairs.map((pair) => ({ from: pair.source, to: pair.destination, kind: "note" as const })),
    { now: options.now },
  );

  const references = await rewriteReferences(store, {
    clearance: options.clearance,
    state,
    renames: new Map(pairs.map((pair) => [pair.source, pair.destination])),
    /*
      A note that links to itself is rewritten here too, which moves its etag
      past the one the copy produced — and the queue would then send its next
      step against a version its own rename had already superseded.
    */
    onRewritten: (key, etag) => {
      if (!sourceIsFolder && key === to) movedEtag = etag;
    },
  });

  return {
    from,
    to,
    paths: pairs.map((pair) => pair.destination),
    references,
    ...(movedEtag === undefined ? {} : { etag: movedEtag }),
  };
}

/* -------------------------------------------------------------------------- */
/*                       moving between two contexts                          */
/* -------------------------------------------------------------------------- */

/**
 * ONE MOVE, TWO BUCKETS, AND NEITHER FUNCTION HOLDS BOTH.
 *
 * `movePath` above is the whole operation in one call because it has one
 * store. A move into *another* context has two, in two different customers'
 * accounts under two different credentials, and there is no portable
 * server-side copy between them — the adapter has `get`/`put`/`delete`/`list`
 * and nothing else. So the bytes have to travel through the caller, and the
 * caller is the control plane.
 *
 * That is why this is three exported functions rather than one. Each takes a
 * single store, so each runs behind its own credential barrier
 * (`runFileOperation`), and the orchestrator that calls all three in turn
 * — `functions/contextMoves.ts` — never holds a bucket key at all. A single
 * `moveAcrossStores(source, destination, …)` would have been shorter and would
 * have required a second credential barrier to exist, holding two customers'
 * plaintext secrets in one scope. The enumeration in
 * `__tests__/structure.test.ts` says what that costs; this is the shape that
 * does not pay it.
 *
 * The order is copy, verify, delete, per batch, which is the discipline the
 * gateway's `materialize_move` already uses: nothing is removed from the
 * source until the destination has answered with an etag for it. A batch that
 * dies halfway leaves objects in both places, which is recoverable by running
 * the move again — the copied ones are gone from the source by then, so the
 * next pass simply does not see them. The opposite order is not recoverable.
 *
 * ## What a cross-context move deliberately does not do
 *
 *  - **It does not rewrite links.** `movePath` rewrites every reference it can
 *    see, because the notes that point at the moved one are in the same
 *    bucket. Across a boundary they are not, and a rewrite would have to reach
 *    into a context the mover may only be an editor of. The gateway's
 *    cross-context `move_note` says the same thing in its own output —
 *    "references: not rewritten across workspace boundaries".
 *  - **It does not carry attachments.** Images live under `IMAGE_PREFIX`,
 *    which `isPlumbing` refuses, and they are addressed by leaf name for the
 *    whole context rather than per folder. Carrying them would mean parsing
 *    every body to find which leaves a subtree depends on.
 *  - **It does not widen anything, ever.** See `landingVisibility`.
 */

/** Objects one batch may carry. Bounded by the Convex argument limit, not the store. */
export const CONTEXT_MOVE_BATCH_OBJECTS = 40;

/**
 * Bytes one batch may carry.
 *
 * Convex caps a function's arguments and return value at 16 MiB, and one batch
 * crosses that boundary twice — out of the export barrier and into the import
 * one — so the real ceiling is well under half of it. Eight megabytes leaves
 * room for the paths and etags travelling beside the bodies, and a single
 * object larger than this is still carried: the check is made *before* each
 * read rather than after, so a batch always carries at least one object and a
 * move can never wedge on a note it refuses to pick up.
 */
export const CONTEXT_MOVE_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Objects a move may leave behind before it stops asking.
 *
 * Something left behind is skipped by every later batch, so the skip list is
 * the one part of a move's state that grows. It is small in practice — a note
 * encrypted to the source context's key is the only thing that lands on it —
 * and a folder with a hundred of them is a different problem from the one this
 * operation solves.
 */
export const CONTEXT_MOVE_SKIP_CAP = 100;

export interface ContextMoveObject {
  /** Key in the source bucket. */
  source: string;
  /** Key in the destination bucket. */
  destination: string;
  bytes: ArrayBuffer;
  /** What the source held when it was read. The delete is conditional on it. */
  etag: string;
  /** Exact collaboration revision to tombstone after the other context lands it. */
  collaborationEtag?: string;
  /**
   * The source's effective visibility, collapsed to the two tiers.
   *
   * A group rule reads `private` here, and that is the gateway's decision made
   * again rather than a lossy cast: `@supa-leads` names a group in the SOURCE
   * workspace, and the destination resolves names in its own. Carrying the
   * string would write a rule the destination cannot resolve — reaching nobody
   * today, and reaching the wrong people the day that name is minted there.
   */
  sourceVisibility: "private" | "team";
}

/** A key this move will not carry, and the reason it can be shown. */
export interface ContextMoveSkip {
  path: string;
  reason: "encrypted";
}

export interface ContextMoveExport {
  objects: ContextMoveObject[];
  skipped: ContextMoveSkip[];
  /** Whether anything under the source is still waiting after these. */
  remaining: boolean;
}

/**
 * What the destination should land an object at, which is never wider than
 * either end.
 *
 * Two questions, and the answer is the narrower of the two: what the object
 * could be seen as where it came from, and what the folder it is landing in
 * already publishes. A `team` note into a private-default folder lands
 * private — the destination's own default wins. A `private` note into a
 * team-default folder lands private too, with an exception written for it —
 * the source's tier wins.
 *
 * **So a cross-context move never publishes anything to anybody who could not
 * already read it, on either side, and it needs no confirmation step to say
 * so.** The gateway's `move_note` refuses that second case instead, behind
 * `confirm_team_publish`; refusing is the right answer for a tool call, where
 * an agent picked the destination and the person may not have seen it, and the
 * wrong one for a folder of mixed notes that somebody dragged somewhere on
 * purpose — one checkbox cannot express per-note intent, and the safe reading
 * of it is the one this function already takes.
 */
export function landingVisibility(
  sourceVisibility: "private" | "team",
  destinationFolderDefault: Visibility,
): "private" | "team" {
  return sourceVisibility === "team" && destinationFolderDefault === "team" ? "team" : "private";
}

/**
 * Folders this caller can see, everywhere in the context, in one call.
 *
 * For the destination picker: "move this into @work" needs @work's folders,
 * and the console's tree only ever holds the folders of the context it is
 * standing in. Asking for them one `listFiles` at a time would be one Convex
 * action — and one bucket credential — per folder, so the walk happens here,
 * inside the single call that already has the store open.
 *
 * Bounded twice over, because the bucket is a customer's and somebody is
 * waiting on this: `FOLDER_PATH_CAP` folders and `FOLDER_PATH_LISTINGS`
 * listings. Past either it reports `truncated` and returns what it has, which
 * is the honest shape for a picker — a short list somebody can still use beats
 * a refusal, and the destination they wanted can always be typed into a
 * subfolder of one that is here. It is the same choice `listFolder` makes one
 * folder down, and the opposite of `keysUnder`'s, for the reason that function
 * gives: a partial *walk* cannot be operated on, and a partial *list* can be
 * read.
 */
export const FOLDER_PATH_CAP = 500;
const FOLDER_PATH_LISTINGS = 200;

export async function listFolderPaths(
  store: FileStore,
  options: { clearance: Clearance },
): Promise<{ folders: string[]; truncated: boolean }> {
  const state = await loadPrivacyState(store);
  if (state.invalid) {
    // Fail closed, exactly as every read does: an unreadable manifest is not a
    // reason to show somebody every folder in the bucket.
    throw new FileOpError(
      "PRIVACY_MANIFEST_INVALID",
      "privacy.md could not be read, so this context's folders cannot be listed.",
    );
  }

  const folders: string[] = [];
  const queue: string[] = [""];
  let listings = 0;
  let truncated = false;

  while (queue.length > 0) {
    const folder = queue.shift()!;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      if (listings >= FOLDER_PATH_LISTINGS) return { folders, truncated: true };
      listings += 1;
      const listing = await store.list({
        prefix: folder === "" ? "" : `${folder}/`,
        delimiter: "/",
        limit: 1_000,
        cursor,
      });
      for (const raw of listing.delimitedPrefixes ?? []) {
        const child = raw.replace(/\/+$/, "");
        if (!child || isPlumbing(child)) continue;
        if (!folderVisibleAtScope(child, options.clearance, state.rules, state.overrides)) continue;
        if (folders.length >= FOLDER_PATH_CAP) {
          truncated = true;
          continue;
        }
        folders.push(child);
        queue.push(child);
      }
      if (!listing.truncated) break;
      if (!listing.cursor || seen.has(listing.cursor)) {
        truncated = true;
        break;
      }
      seen.add(listing.cursor);
      cursor = listing.cursor;
      if (page === LIST_PAGE_CAP - 1) truncated = true;
    }
  }

  folders.sort();
  return { folders, truncated };
}

/**
 * Read the next bounded piece of what is moving out of this context.
 *
 * **It lists from the beginning of the subtree every time, and that is the
 * property that makes a move of any size finish.** A persisted continuation
 * cursor over a listing whose keys are being deleted underneath it can skip
 * objects on S3-compatible providers — `clearVaultBatch` says the same thing
 * above, for the same reason — and it would also make every retry a guess
 * about how far the last attempt got. Listing from the start costs nothing
 * extra because the previous batch's objects are *gone* by the time this runs:
 * the first page is already the next thing to move. Only what was deliberately
 * left behind is paged over again, which is what `skip` is for and why it is
 * capped.
 *
 * So this has no cap on the size of the folder. `keysUnder` refuses past
 * `FOLDER_OPERATION_CAP` because a single-store move rewrites the manifest as
 * though the whole walk happened and a partial walk cannot be operated on
 * safely. Here the unit that must be all-or-nothing is one *object* — copied,
 * verified, then deleted — so a pass that sees only the first forty of nine
 * thousand is an ordinary pass rather than a half-done move.
 */
export async function exportContextMoveBatch(
  store: FileStore,
  options: {
    from: string;
    to: string;
    clearance: Clearance;
    /** Keys an earlier pass could not carry. Never re-offered. */
    skip?: readonly string[];
    limit?: number;
    maxBytes?: number;
  },
): Promise<ContextMoveExport> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(from);
  assertWritablePath(to);
  // Before the first read, not after the first copy: a move that discovered
  // this on the way to retiring a source would already have written the
  // destination, and the only way out of that is a duplicate.
  assertSourceCanRetire(store);

  const state = await loadPrivacyState(store);
  if (state.invalid) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_INVALID",
      "privacy.md could not be read in the context this is moving out of. Nothing was moved.",
    );
  }
  if (!canSee(from, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) {
    throw notFound();
  }

  const limit = options.limit ?? CONTEXT_MOVE_BATCH_OBJECTS;
  const maxBytes = options.maxBytes ?? CONTEXT_MOVE_BATCH_BYTES;
  const skip = new Set(options.skip ?? []);

  const sourceIsFolder = await isFolder(store, from);
  const candidates: string[] = [];
  let remaining = false;

  if (!sourceIsFolder) {
    if (!skip.has(from)) candidates.push(from);
  } else {
    const prefix = `${from}/`;
    const seen = new Set<string>();
    let cursor: string | undefined;
    pages: for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      const listing = await store.list({ prefix, cursor, limit: 1_000 });
      for (const object of listing.objects ?? []) {
        const key = object.key;
        if (isPlumbing(key)) continue;
        if (skip.has(key)) continue;
        if (!canSee(key, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) {
          // Only reachable if this ever runs at `team`, which it does not:
          // starting a move out of a context requires owning it, and an owner
          // reads at `private`. Kept because "the caller sees everything" is an
          // argument about a caller, and this function takes a clearance.
          continue;
        }
        if (candidates.length >= limit) {
          remaining = true;
          break pages;
        }
        candidates.push(key);
      }
      if (!listing.truncated) break;
      if (!listing.cursor || seen.has(listing.cursor)) {
        // A store that will not page is not a store this can finish against,
        // and saying so beats moving an arbitrary prefix of a folder.
        throw new FileOpError(
          "LISTING_INCOMPLETE",
          "That folder could not be listed to the end, so nothing more was moved. Try again.",
        );
      }
      seen.add(listing.cursor);
      cursor = listing.cursor;
    }
  }

  const objects: ContextMoveObject[] = [];
  const skipped: ContextMoveSkip[] = [];
  let carried = 0;
  let looked = 0;
  for (const key of candidates) {
    // Checked before the read, so one object over the ceiling is still carried
    // rather than refused forever. The pass after this one starts behind it.
    if (carried > 0 && carried >= maxBytes) break;
    looked += 1;
    const object = await store.get(key);
    if (object === null) continue; // deleted underneath us; nothing to carry
    let bytes = await object.arrayBuffer();
    const sourceText = key.endsWith(".md") ? new TextDecoder().decode(bytes) : null;
    if (sourceText !== null && isEncryptedNote(sourceText)) {
      /*
        AN ENCRYPTED NOTE IS ENCRYPTED TO *THIS* CONTEXT'S KEY.

        Its ciphertext would arrive in the destination as a note nobody there
        can ever open, including the person who moved it — the data key is held
        per workspace (`functions/encryptionKeys.ts`) and does not travel.
        Carrying it would be a silent, permanent loss dressed up as a
        successful move, so it stays where it can still be read and the move
        reports it by name.
      */
      skipped.push({ path: key, reason: "encrypted" });
      continue;
    }
    let collaborationEtag: string | undefined;
    if (sourceText !== null && collaborationSupported(store) &&
        collaborationEligible(key, sourceText)) {
      if (store.capabilities?.conditionalDelete !== true) {
        throw new FileOpError(
          "STORAGE_UNSAFE",
          "This storage cannot safely retire a collaboratively edited note. Nothing from this batch was removed.",
        );
      }
      try {
        const base = await readCollaborationDocument(store, key);
        bytes = new TextEncoder().encode(base.text).buffer;
        collaborationEtag = base.etag;
      } catch {
        throw new FileOpError(
          "CONFLICT",
          "A note changed while this context move was reading it. Nothing from this batch was removed.",
        );
      }
    }
    carried += bytes.byteLength;
    objects.push({
      source: key,
      destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
      bytes,
      etag: object.etag,
      ...(collaborationEtag === undefined ? {} : { collaborationEtag }),
      sourceVisibility:
        effectiveVisibility(key, state.rules, state.overrides) === "team" ? "team" : "private",
    });
  }

  // Anything this pass listed but did not reach is still waiting. Folded in
  // here rather than set at each `break` above, because the two ceilings and
  // the skip both leave work behind and only one of them is a loop exit.
  return { objects, skipped, remaining: remaining || looked < candidates.length };
}

export interface ContextMoveImport {
  /** What actually exists at the destination now, with the etag it was given. */
  landed: { source: string; destination: string; etag: string }[];
  /**
   * Why the batch stopped, if it did.
   *
   * A partial batch is reported rather than thrown, because the sources for
   * everything in `landed` must still be deleted: throwing would leave copies
   * in both buckets with nothing recording that they are copies.
   */
  failure: { destination: string; code: FileErrorCode; message: string } | null;
}

/**
 * Land a batch in the destination context, narrowing before it writes.
 *
 * The exceptions go in **first**, in one manifest write for the whole batch,
 * and the objects follow. The order is the whole point: a private note put
 * into a team-default folder and then narrowed is a note that was readable by
 * the destination's team for as long as the second write took. The gateway's
 * cross-context move makes the same choice, one note at a time
 * (`persistExactVisibility` before the `put`).
 */
export async function importContextMoveBatch(
  store: FileStore,
  options: {
    objects: readonly ContextMoveObject[];
    clearance: Clearance;
    /**
     * The move's destination root, on the first batch only.
     *
     * Checked once rather than per object, and only when nothing has landed
     * yet — by the second batch this move's own objects are under it, so the
     * same check would then refuse the move on the strength of its own work.
     *
     * It is what stops a folder move **merging** into a folder that is already
     * there. The per-object `get` below cannot see that: for a folder move
     * every destination is `to` plus a suffix, so two trees interleave key by
     * key with no key ever colliding, and `movePath` records what the result
     * is — the source folder's rule carried onto a destination that already
     * had notes in it, one of which went from hidden to readable. A file
     * already sitting at `to` is the other half of the same question, and is
     * invisible to a per-object check for the same reason.
     */
    root?: string;
  },
): Promise<ContextMoveImport> {
  assertDestinationCanLand(store);

  const state = await loadPrivacyState(store);
  if (state.invalid) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_INVALID",
      "privacy.md could not be read in the context this is moving into. Nothing was moved.",
    );
  }

  if (options.root !== undefined) {
    const root = requirePath(options.root);
    assertWritablePath(root);
    if (await isFolder(store, root)) {
      // Refused whether or not they can see it, and `notFound` when they
      // cannot: "that folder already exists" about a folder somebody cannot
      // list is the disclosure, not the merge. Same shape as `movePath`'s.
      if (!folderVisibleAtScope(root, options.clearance, state.rules, state.overrides)) {
        throw notFound();
      }
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `${root} already exists there. Moving one folder onto another would merge them.`,
      );
    }
    if ((await store.get(root)) !== null) {
      if (!canSee(root, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) {
        throw notFound();
      }
      throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${root}.`);
    }
  }

  const planned = options.objects.map((object) => {
    const destination = requirePath(object.destination);
    assertWritablePath(destination);
    return {
      object,
      destination,
      visibility: landingVisibility(object.sourceVisibility, visibilityOf(destination, state.rules)),
    };
  });

  /*
    THE MOVER'S OWN CLEARANCE IN THE DESTINATION, ASKED BEFORE ANYTHING IS
    WRITTEN.

    Starting a move needs `editor` there, and an editor reads at `team` — so
    the same rule every other write in this file obeys applies here: they may
    land something in a folder they can see, and a `private` folder of somebody
    else's context is not one. Without this, "move into @theirs" would be a way
    to write into a folder the mover cannot list, and to learn from the result
    that it is there.

    The identical guard `movePath` uses, deliberately: this is the one place a
    write arrives in a context from outside it, and a second implementation of
    "may they write here" is a second one to get wrong. An owner
    (`scope: "private"`) passes it unconditionally, which is the arm every move
    started by the destination's own owner takes.
  */
  assertDestinationsVisible(
    planned.map((entry) => entry.destination),
    options.clearance,
    state.rules,
    state.overrides,
  );

  const narrowed = planned.filter(
    (entry) => entry.visibility !== visibilityOf(entry.destination, state.rules),
  );
  if (narrowed.length > 0) {
    await mutateManifest(store, (current) => {
      let overrides = current.overrides;
      for (const entry of narrowed) {
        overrides = nextOverrides(entry.destination, entry.visibility, current.rules, overrides);
      }
      return { rules: current.rules, overrides };
    });
  }

  const landed: ContextMoveImport["landed"] = [];
  for (const entry of planned) {
    try {
      if ((await store.get(entry.destination)) !== null) {
        return {
          landed,
          failure: {
            destination: entry.destination,
            code: "DESTINATION_EXISTS",
            message: `Something already exists at ${entry.destination}.`,
          },
        };
      }
      // Unconditionally conditional: `assertDestinationCanLand` has already
      // refused a store that cannot do this, so there is no fallback arm to
      // get wrong — and the fallback that used to be here was a read-compare,
      // which is exactly the window this operation must not have.
      const created = await store.put(entry.destination, entry.object.bytes, {
        onlyIf: { absent: true },
      });
      if (created === null) {
        return {
          landed,
          failure: {
            destination: entry.destination,
            code: "DESTINATION_EXISTS",
            message: `Something already exists at ${entry.destination}.`,
          },
        };
      }
      landed.push({
        source: entry.object.source,
        destination: entry.destination,
        etag: created.etag,
      });
    } catch (error) {
      return {
        landed,
        failure: {
          destination: entry.destination,
          code: "STORAGE_UNSAFE",
          message: error instanceof Error ? error.message : "The destination bucket refused a write.",
        },
      };
    }
  }
  return { landed, failure: null };
}

/**
 * Take the copied objects out of the source, and only those.
 *
 * Conditional on the etag each was read at, so a note somebody edited between
 * the copy and this call is **not** deleted: the copy at the destination is
 * the older text, and silently removing the newer one would lose the edit. It
 * is reported as a conflict instead, and the caller removes the stale copy it
 * made and stops — see `contextMoves.ts`.
 */
/**
 * Take one copied object out, under a guard the storage will actually enforce.
 *
 * **A conditional DELETE is not that guard on the storage this product runs
 * on.** R2 accepts `If-Match` on DELETE and ignores it — measured, in
 * `apps/mcp`'s "Move a note on storage that will not enforce a conditional
 * delete", once every binding was probed instead of inheriting a claim: every
 * real row came back `conditionalDelete: false` and `conditionalWrite: true`.
 * So the obvious `delete(path, { onlyIf: { etagMatches } })` either refuses
 * every move (if the capability is required) or silently destroys the edit
 * somebody made mid-move (if it is not) — and the second is what the
 * unguarded fallback here used to do, while this file's own comment claimed
 * the newer text was kept.
 *
 * The substitute is the gateway's `retireMovedSource`, ported rather than
 * reinvented so the two engines cannot drift on a data-loss guard:
 *
 *   1. PUT a zero-byte marker at the source path under `If-Match` on the etag
 *      that was copied. Atomic, and it fails if anybody touched the note —
 *      the same conflict, established from the same evidence.
 *   2. Delete the marker. By then the only thing at that key is ours, so the
 *      delete cannot destroy a customer's bytes whether or not it is
 *      conditional.
 *
 * `unguarded` is a store that can do neither, which `assertContextMoveSafe`
 * refuses before anything is copied. It is returned rather than thrown so that
 * a caller which somehow reaches it treats it as a refusal instead of as a
 * successful retirement.
 */
async function retireMovedSource(
  store: FileStore,
  key: string,
  etag: string,
): Promise<"retired" | "conflict" | "unguarded"> {
  if (etag === "") return "unguarded";
  if (store.capabilities?.conditionalDelete === true) {
    const deleted = await store.delete(key, { onlyIf: { etagMatches: etag } });
    return deleted === null ? "conflict" : "retired";
  }
  if (store.capabilities?.conditionalWrite !== true) return "unguarded";
  const claimed = await store.put(key, new Uint8Array(0), { onlyIf: { etagMatches: etag } });
  if (claimed === null) return "conflict";
  try {
    await store.delete(key);
  } catch {
    // A zero-byte marker at a path whose content is already at the destination.
    // The next pass lists it, finds nothing to carry, and removes it; reporting
    // the move as failed here would be the false half of a move that happened.
  }
  return "retired";
}

/**
 * What each end of a cross-context move needs of its own store.
 *
 * The gateway's `moveSafetyRefusal`, split in two because the two stores are
 * opened by two different calls through the credential barrier and nothing in
 * this process ever holds both. Each half is asked **before its own side does
 * anything**, and refused by name rather than silently degraded: the
 * degradation is "your edit was destroyed instead of refused", which is the
 * one outcome this operation may never have.
 *
 * Either conditional satisfies the source, for the reason `retireMovedSource`
 * gives at length. B2 and Wasabi have neither and are refused, which is what
 * every other conflict-safe path in this file already does to them.
 */
function assertSourceCanRetire(store: FileStore): void {
  if (
    store.capabilities?.conditionalDelete !== true &&
    store.capabilities?.conditionalWrite !== true
  ) {
    throw new FileOpError(
      "STORAGE_UNSAFE",
      "This context is on storage that cannot make a conflict-safe write, so a note edited while it moved would be lost rather than refused. Nothing was moved.",
    );
  }
}

function assertDestinationCanLand(store: FileStore): void {
  if (store.capabilities?.conditionalCreate !== true) {
    throw new FileOpError(
      "STORAGE_UNSAFE",
      "The context you are moving into is on storage that cannot write a file only if it is absent, so a move there could overwrite something. Nothing was moved.",
    );
  }
}

export async function deleteMovedSources(
  store: FileStore,
  options: { sources: readonly { path: string; etag: string; collaborationEtag?: string }[] },
): Promise<{ deleted: string[]; conflicts: string[] }> {
  const deleted: string[] = [];
  const conflicts: string[] = [];
  for (const source of options.sources) {
    if (source.collaborationEtag !== undefined) {
      try {
        await tombstoneCollaborationDocument(store, source.path, {
          expectedEtag: source.collaborationEtag,
        });
        deleted.push(source.path);
      } catch {
        conflicts.push(source.path);
      }
    } else {
      const retired = await retireMovedSource(store, source.path, source.etag);
      if (retired === "retired") deleted.push(source.path);
      else conflicts.push(source.path);
    }
  }

  if (deleted.length > 0) {
    const state = await loadPrivacyState(store);
    if (state.text !== null && !state.invalid && deleted.some((path) => hasOverride(state.overrides, path))) {
      await mutateManifest(store, (current) => {
        let overrides = current.overrides;
        for (const path of deleted) overrides = clearedOverrides(path, overrides);
        return { rules: current.rules, overrides };
      });
    }
  }
  return { deleted, conflicts };
}

/**
 * Forget what the source manifest still says about a subtree nothing is left in.
 *
 * Run once, after the last batch. A folder rule whose folder is gone is not
 * inert: the name comes back the day anybody recreates that path — an
 * ingestion alias filing into `1-projects/acme`, a new note saved to the same
 * place — and it comes back carrying a visibility nobody chose for it. Rules
 * covering something that stayed behind are kept, which is why this takes the
 * survivors rather than assuming there are none.
 */
export async function clearMovedSourceRules(
  store: FileStore,
  options: { from: string; survivors?: readonly string[] },
): Promise<void> {
  const from = requirePath(options.from);
  const survivors = options.survivors ?? [];
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;

  const under = (path: string) => path === from || path.startsWith(`${from}/`);
  const kept = (prefix: string) =>
    survivors.some((path) => path === prefix || path.startsWith(`${prefix}/`));

  const staleRule = state.rules.some((rule) => under(rule.prefix) && !kept(rule.prefix));
  const staleOverride = [...state.overrides.keys()].some(
    (path) => under(path) && !survivors.includes(path),
  );
  if (!staleRule && !staleOverride) return;

  await mutateManifest(store, (current) => ({
    rules: current.rules.filter((rule) => !under(rule.prefix) || kept(rule.prefix)),
    overrides: new Map(
      [...current.overrides].filter(([path]) => !under(path) || survivors.includes(path)),
    ),
  }));
}

/**
 * How many notes a move will read looking for references to what moved.
 *
 * The gateway's `LINK_SCAN_CAP` and the same argument: a move is rare and
 * deliberate, so a full walk is the right trade, and "full" needs a number
 * because the bucket is a customer's. Past this the move still happens and the
 * rewrite is reported as **not done**, which is the honest failure — a partial
 * rewrite announcing success would leave somebody believing their links were
 * fixed.
 */
const LINK_SCAN_CAP = 4000;

/**
 * Point every link at where its note went.
 *
 * The control plane's half of the rule the gateway states in full at
 * `apps/mcp/src/links.js`: a reference follows what it points at, by default,
 * because a workspace whose links rot the first time somebody tidies a folder is a
 * workspace people stop tidying. A rename made in the console and the same rename
 * made through an MCP client have to do the same thing, and
 * `linkParity.test.ts` is what keeps the two engines honest about that.
 *
 * Three things here are decisions rather than mechanics, and each is the
 * gateway's:
 *
 *   - **Only what this caller can see.** `keysUnder` already withholds what
 *     `canSee` refuses and the manifest bookkeeping is built on that; a rewrite
 *     that reached further would be the one operation in this file that acts
 *     outside the caller's surface, and its *count* would be an inference
 *     channel about notes they cannot list.
 *   - **The moved notes are rewritten too.** A note carried by a folder move
 *     keeps every relative link it had, and each one now needs a different
 *     number of `../`.
 *   - **Names resolve as they were before the move**, because a bare
 *     `[[overview]]` was written against the bucket as it was.
 *
 * It runs after `remapPrivacy`, so the visibility of every destination is
 * already settled and `canSee` below is asking about the bucket as it now is.
 * A failure to walk is reported, never thrown: the move has landed and must not
 * be undone because its bookkeeping could not finish.
 */
async function rewriteReferences(
  store: FileStore,
  options: {
    clearance: Clearance;
    state: PrivacyState;
    renames: ReadonlyMap<string, string>;
    /** Told the new etag of every note this rewrites. See `movePath`'s `etag`. */
    onRewritten?: (key: string, etag: string) => void;
  },
): Promise<ReferenceRewrite> {
  if (options.renames.size === 0) return { notes: 0, links: 0, capped: false };

  let keys: string[] | null;
  try {
    keys = await visibleNoteKeys(store, options.clearance, options.state);
  } catch {
    return { notes: 0, links: 0, capped: true };
  }
  if (keys === null || keys.length > LINK_SCAN_CAP) return { notes: 0, links: 0, capped: true };

  const wasAt = new Map<string, string>();
  for (const [source, destination] of options.renames) wasAt.set(destination, source);
  const byName = indexByName(keys.map((key) => wasAt.get(key) ?? key));

  let notes = 0;
  let links = 0;
  for (const key of keys) {
    const object = await store.get(key);
    if (object === null) continue;
    const text = await object.text();
    const rewritten = rewriteLinks(text, {
      fromPath: wasAt.get(key) ?? key,
      toPath: key,
      renames: options.renames,
      byName,
    });
    if (rewritten === null) continue;
    notes += 1;
    links += rewritten.changed;
    /*
      A migrated note's Markdown is a materialization of its collaboration
      head. Route that rewrite through the same retained-base operation so a
      backlink repair cannot be discarded by the next collaborative read.
      Unmigrated or ineligible objects retain the ordinary raw write path.
    */
    let etag: string | undefined;
    if (collaborationSupported(store) && collaborationEligible(key, text) && !isEncryptedNote(text)) {
      try {
        const current = await readCollaborationDocument(store, key);
        const replaced = await replaceCollaborationText(store, key, {
          documentId: current.documentId,
          expectedEtag: current.etag,
          text: rewritten.text,
        });
        etag = replaced.etag;
      } catch {
        // A migrated note must never fall back to a raw PUT. A move may have
        // changed its path between the listing and this repair; leaving the
        // repair pending is safer than overwriting a head at an old revision.
        continue;
      }
    } else {
      const put = await store.put(key, rewritten.text);
      etag = put?.etag;
    }
    if (etag) options.onRewritten?.(key, etag);
  }
  return { notes, links, capped: false };
}

/**
 * Every note in the bucket this caller can see, or `null` if the walk ran out
 * of pages before reaching the end.
 *
 * `null` rather than a short list, for the reason `keysUnder` gives about its
 * own `complete` flag: a truncated walk reads exactly like a finished one, and
 * the caller here would then rewrite part of a bucket and report a total.
 */
async function visibleNoteKeys(
  store: FileStore,
  clearance: Clearance,
  state: PrivacyState,
): Promise<string[] | null> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: "", cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (isPlumbing(object.key)) continue;
      if (!object.key.endsWith(".md")) continue;
      if (!canSee(object.key, clearance.scope, state.rules, state.overrides, clearance.names)) continue;
      if (seen.has(object.key)) continue;
      seen.add(object.key);
      keys.push(object.key);
    }
    if (!listing.truncated) return keys;
    const next = listing.cursor;
    // A page that reports more and hands back no way to ask for it is the
    // shape `keysUnder` documents: ending the walk here would return a short
    // list that reads like a complete one.
    if (!next || next === cursor) return null;
    cursor = next;
  }
  return null;
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
  options: { from: string; to: string; clearance: Clearance },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  // Both ends, which `movePath` has always done and this had not. `privacy.md`
  // is the access map for the whole context, and it is readable at owner scope
  // — so an owner could copy it into a shared folder and hand every member the
  // complete list of their private folders by name. Measured before this line:
  // 935 bytes of `folder_defaults` readable at team scope. The manifest is
  // `isPlumbing`, so this is the same refusal every other reserved path gets.
  assertWritablePath(from);
  assertWritablePath(to);
  if (to === from || to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be copied inside itself.");
  }

  const state = await loadPrivacyState(store);
  if (!canSee(from, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  // `copyPrivacy` only ever writes a per-note exception, never a folder rule,
  // so a partial copy has nothing to get wrong and `filtered` is not needed.
  const sources = sourceIsFolder
    ? (await keysUnder(store, from, options.clearance, state.rules, state.overrides)).keys
    : [from];
  if (sources.length === 0) throw notFound();

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  assertDestinationsVisible(
    pairs.map((pair) => pair.destination),
    options.clearance,
    state.rules,
    state.overrides,
  );

  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      // This message names the path back, which is safe only because the guard
      // above has established that the caller can see both the key and the
      // folder holding it. An earlier version of this comment claimed the guard
      // read "the same rules this loop reads" and that the line was therefore
      // unreachable with a hidden path. That was wrong, and instrumenting it is
      // what showed it: the guard seeds a carried exception into its override
      // map, so a note the owner had shared out of a private folder made any
      // destination pass, and this line then answered from the real manifest.
      // The folder check above is what actually closes it.
      //
      // "No test reaches it" was the evidence for the old claim, and it was the
      // wrong kind of evidence — the suite had no team-scope coverage of this
      // line at all. There is one now.
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `Something already exists at ${pair.destination}.`,
      );
    }
  }

  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) throw notFound();
    const sourceText = await object.text();
    let body = sourceText;
    if (collaborationSupported(store) && !isEncryptedNote(sourceText) && collaborationEligible(pair.source, sourceText)) {
      try {
        body = (await readCollaborationDocument(store, pair.source)).text;
      } catch {
        throw new FileOpError("STORAGE_UNSAFE", "This note cannot be copied safely for collaborative editing.");
      }
    }
    await store.put(pair.destination, body);
  }

  await copyPrivacy(
    store,
    pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
    sourceIsFolder ? { from, to } : null,
  );

  return { from, to, paths: pairs.map((pair) => pair.destination) };
}

/** Copy beside itself under a free "… copy" name. */
export async function duplicatePath(
  store: FileStore,
  options: { path: string; clearance: Clearance },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  const parent = parentOf(path);

  // Before the listing, not after it — and in `copyPath`'s order, which is
  // `assertWritablePath` and then `canSee`. Both of those run on this same path
  // a few lines below, so no input is accepted or refused that was not already,
  // and keeping the order keeps every refusal byte-identical too: dropping
  // `assertWritablePath` here made Duplicate the only operation in this file
  // that answered `FILE_NOT_FOUND` for a dot-prefixed path where `writeFile`,
  // `movePath`, `copyPath` and `deletePath` all answer `PATH_INVALID`.
  //
  // What changes is only what happens *before* a refusal. A caller who cannot
  // see `path` no longer causes a full walk of its parent on the strength of a
  // name they typed — and no longer reads that folder's *size* off the answer:
  // `namesInUse` refuses a walk it could not finish, so a parent too large to
  // list came back `FOLDER_TOO_LARGE` while a small one came back
  // `FILE_NOT_FOUND`, for two notes the caller could see neither of.
  assertWritablePath(path);
  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  // Every name in use, not every name this caller can see.
  //
  // Picking from the visible siblings alone chooses a name a hidden note may
  // already hold, and `copyPath`'s guard then refuses it — so Duplicate
  // answered "that file does not exist" if and only if a private note occupied
  // the "… copy" name, and the caller could aim it by writing the name they
  // wanted to test first.
  //
  // The names read here never leave this function. What does leave is the one
  // it picks, and that still carries a bit: `x copy 2.md` where `x copy.md` was
  // free says something holds `x copy.md`. That is the residual
  // `assertDestinationsVisible` documents and `writeFile` has had all along —
  // the same caller learns as much in one write — so this removes a hard
  // refusal rather than an inference. Saying it discloses nothing would be the
  // overclaim this file has already made once.
  const taken = await namesInUse(store, parent);
  const destination = joinPath(parent, duplicateName(baseName(path), taken));
  return await copyPath(store, { from: path, to: destination, clearance: options.clearance });
}

/* -------------------------------------------------------------------------- */
/*                            archiving and deleting                          */
/* -------------------------------------------------------------------------- */

/**
 * Archive: move into `<this context's archive>/<timestamp>/<original path>`.
 *
 * This is the destructive-looking action people should reach for, and it is
 * **not destructive** — the file is intact, its original path is preserved
 * inside the archive path, and moving it back restores it exactly. The
 * timestamp segment means archiving the same note twice never collides.
 *
 * Same destination shape the gateway's `archive_note` uses, **and now the same
 * destination**, which it was not. Both were written against a literal
 * `4-archive`; the gateway refused a context that did not declare one, and
 * this created it regardless. So on a `company`-preset workspace — a layout
 * whose archive is `5-archive`, and the default for a shared context — Claude
 * refused to archive and the console quietly opened a second archive beside
 * the real one, in a bucket the owner also sees in Obsidian. One resolver
 * (`archiveRoot`) now answers for both, and this path adopts the gateway's
 * refusal rather than its own invention: a context with no archive folder is
 * told so, instead of being given one nobody chose.
 */
export async function archivePath(
  store: FileStore,
  options: {
    path: string;
    clearance: Clearance;
    now: number;
    /** The version this archive was asked about. See `movePath`. */
    expectedEtag?: string;
  },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  // Ahead of the destination rather than after it: which folder this context
  // archives into is a fact about its manifest, so the manifest is read first
  // and the same state answers the visibility check below.
  const state = await loadPrivacyState(store);
  const roots = archiveRoots(state.rules);
  const archive = archiveRoot(state.rules);
  // Every archive it has, not the one we would write to: a note already in
  // `5-archive/` must not be moved into `4-archive/` because the resolver
  // preferred the latter.
  if (insideArchive(path, roots)) {
    throw new FileOpError("PATH_INVALID", "That is already in the archive.");
  }
  if (archive === null) {
    throw new FileOpError(
      "ARCHIVE_UNAVAILABLE",
      "This context has no archive folder, and archiving will not create one — its layout is yours. Move this to wherever you keep inactive material, or add an archive folder to privacy.md.",
    );
  }
  // A free destination, because `movePath` refuses to merge onto an existing
  // folder and archiving a child and then its parent inside the same
  // millisecond lands the second one on top of the first. The stamp is
  // server-generated and never caller-chosen, so disambiguating it discloses
  // nothing and keeps "never merges" true rather than carving an exception into
  // it. Archiving twice in one millisecond is a scripted or concurrent caller,
  // not a person clicking twice.
  const stamp = timestampSlug(options.now);
  let destination = `${archive}/${stamp}/${path}`;
  for (let attempt = 2; attempt <= 100; attempt += 1) {
    if (!(await isFolder(store, destination)) && (await store.get(destination)) === null) break;
    destination = `${archive}/${stamp}-${attempt}/${path}`;
  }

  // Archiving is a move, so it inherits the destination rule — and on the
  // scaffold's defaults the archive is private, which means a team caller
  // cannot archive. That is right: archiving a shared note into a private
  // archive takes it away from everybody else, irreversibly for the person who
  // did it. The gateway's `archive_note` has always refused it.
  //
  // What it must not do is inherit the *message*. "That file does not exist"
  // about a note the caller is looking at explains nothing and points at the
  // wrong thing. Naming the folder discloses nothing they do not already hold:
  // whether it is shared is visible in their own root listing.
  if (options.clearance.scope !== "private" && visibilityOf(destination, state.rules) !== "team") {
    throw new FileOpError(
      "ARCHIVE_UNAVAILABLE",
      `Archiving needs access to ${archive}, which has not been shared with you. Ask the owner to share it, or move this somewhere you can both see.`,
    );
  }

  return await movePath(store, {
    from: path,
    to: destination,
    clearance: options.clearance,
    now: options.now,
    ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
  });
}

/**
 * Move a visible entry into hidden, recoverable trash without rewriting its
 * privacy rules or links. Keeping those rules at the original path makes Undo
 * restore the exact access state instead of guessing it from the trash folder.
 */
export async function trashPath(
  store: FileStore,
  options: {
    path: string;
    clearance: Clearance;
    now: number;
    /**
     * The version this delete was asked about — see `movePath`. A delete typed
     * offline must not put somebody's newer text in the trash without the
     * person who asked for it being told it changed. Compared after the
     * visibility check, so a note the caller cannot see is `notFound()` and its
     * version is never on the wire.
     */
    expectedEtag?: string;
  },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  assertWritablePath(path);
  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const sourceIsFolder = await isFolder(store, path);
  if (options.expectedEtag !== undefined && sourceIsFolder) {
    throw new FileOpError("PATH_INVALID", "A folder has no version, so it cannot be deleted against one.");
  }
  const walk = sourceIsFolder
    ? await keysUnder(store, path, options.clearance, state.rules, state.overrides)
    : { keys: [path], withheld: [] };
  const source = sourceIsFolder ? null : await store.get(path);
  if (!sourceIsFolder && source === null) throw notFound();
  if (walk.keys.length === 0) throw notFound();
  /*
    A read-compare, made just before the move, on every bucket. `movePairs` is
    shared with the restore and copies-then-deletes unconditionally; the window
    between this read and that delete is the one an online save on a
    read-compare bucket has, and what lands in it is recoverable from the trash
    rather than gone.
  */
  const sourceText = source === null ? null : await source.text();
  const sourceIsCollaborative =
    !sourceIsFolder && sourceText !== null && collaborationSupported(store) &&
    !isEncryptedNote(sourceText) && collaborationEligible(path, sourceText);
  if (options.expectedEtag !== undefined && source !== null && !sourceIsCollaborative && source.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That note changed somewhere else after this was asked for.",
      source.etag,
    );
  }

  // A migrated note moves into the real hidden trash path with its head and
  // document identity intact. The lifecycle API admits this path only through
  // its internalTrash capability; public collaboration reads still reject it.
  if (sourceIsCollaborative && source !== null && sourceText !== null) {
      if (store.capabilities?.conditionalDelete !== true) {
        throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash a collaboratively edited note.");
      }
      let destination = `${TRASH_ROOT}/${timestampSlug(options.now)}/${path}`;
      for (let attempt = 2; await hiddenKeysAt(store, destination).then((keys) => keys.length > 0) && attempt <= 100; attempt += 1) {
        destination = `${TRASH_ROOT}/${timestampSlug(options.now)}-${attempt}/${path}`;
      }
      let moved;
      try {
        moved = await moveCollaborationDocument(store, path, destination, {
          internalTrash: true,
          ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
          throw new FileOpError("CONFLICT", "That note changed somewhere else after this was asked for.", source.etag);
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash a collaboratively edited note.");
        }
        throw error;
      }
      return { from: path, to: destination, paths: [destination], etag: moved.etag };
    }

  const stamp = timestampSlug(options.now);
  let destination = `${TRASH_ROOT}/${stamp}/${path}`;
  for (let attempt = 2; attempt <= 100; attempt += 1) {
    if ((await hiddenKeysAt(store, destination)).length === 0) break;
    destination = `${TRASH_ROOT}/${stamp}-${attempt}/${path}`;
  }
  const pairs = walk.keys.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${destination}${key.slice(path.length)}` : destination,
  }));
  const collaborativePairs = new Set<string>();
  if (collaborationSupported(store)) {
    const candidates: Array<(typeof pairs)[number]> = [];
    for (const pair of pairs) {
      const object = await store.get(pair.source);
      if (object === null) continue;
      const text = await object.text();
      if (!isEncryptedNote(text) && collaborationEligible(pair.source, text)) candidates.push(pair);
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash collaboratively edited notes.");
    }
    for (const pair of candidates) {
      try {
        await moveCollaborationDocument(store, pair.source, pair.destination, { internalTrash: true });
        collaborativePairs.add(pair.source);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (["CONFLICT", "BASE_MISSING", "GENERATION_MISMATCH"].includes(code)) {
          throw new FileOpError("CONFLICT", "A note changed somewhere else while this folder was being trashed.");
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash collaboratively edited notes.");
        }
        throw error;
      }
    }
  }
  const legacyPairs = pairs.filter((pair) => !collaborativePairs.has(pair.source));
  if (legacyPairs.length > 0) await movePairs(store, legacyPairs);
  return { from: path, to: destination, paths: pairs.map((pair) => pair.destination) };
}

/** Restore one trash result to the original path encoded inside its key. */
export async function restoreTrashedPath(
  store: FileStore,
  options: { from: string; to: string; clearance: Clearance },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(to);
  const match = /^\.context\/trash\/[^/]+\/(.+)$/.exec(from);
  if (match === null || match[1] !== to) {
    throw new FileOpError("PATH_INVALID", "That trash entry does not match this restore path.");
  }
  const state = await loadPrivacyState(store);
  if (!canSee(to, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
  const sources = await hiddenKeysAt(store, from);
  if (sources.length === 0 && collaborationSupported(store)) {
    throw notFound();
  }
  if (sources.length === 0) throw notFound();
  const sourceIsFolder = sources.length > 1 || sources[0] !== from;
  const pairs = sources.map((source) => ({
    source,
    destination: sourceIsFolder ? `${to}${source.slice(from.length)}` : to,
  }));
  const collaborativePairs = new Set<string>();
  if (collaborationSupported(store)) {
    const candidates: Array<(typeof pairs)[number]> = [];
    for (const pair of pairs) {
      const object = await store.get(pair.source);
      if (object === null) continue;
      const text = await object.text();
      // A trash key is plumbing and is intentionally ineligible at the public
      // engine boundary. The retained document is still the ordinary note at
      // its restore destination; use that path for the eligibility check while
      // passing internalTrash to the lifecycle move below.
      if (!isEncryptedNote(text) && collaborationEligible(pair.destination, text)) candidates.push(pair);
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely restore a collaboratively edited note.");
    }
    for (const pair of candidates) {
      try {
        await moveCollaborationDocument(store, pair.source, pair.destination, { internalTrash: true });
        collaborativePairs.add(pair.source);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (["CONFLICT", "BASE_MISSING", "GENERATION_MISMATCH", "MOVED"].includes(code)) {
          throw new FileOpError("CONFLICT", "That note changed somewhere else while it was in the trash.");
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely restore a collaboratively edited note.");
        }
        throw error;
      }
    }
  }
  const legacyPairs = pairs.filter((pair) => !collaborativePairs.has(pair.source));
  if (legacyPairs.length > 0) await movePairs(store, legacyPairs);
  return { from, to, paths: pairs.map((pair) => pair.destination) };
}

async function hiddenKeysAt(store: FileStore, path: string): Promise<string[]> {
  if ((await store.get(path)) !== null) return [path];
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: `${path}/`, cursor, limit: 1_000 });
    for (const object of listing.objects) {
      keys.push(object.key);
      if (keys.length > FOLDER_OPERATION_CAP) {
        throw new FileOpError("FOLDER_TOO_LARGE", "That trash entry is too large to restore in one go.");
      }
    }
    if (!listing.truncated) return keys;
    if (!listing.cursor || listing.cursor === cursor) {
      throw new FileOpError("LISTING_INCOMPLETE", "Context could not finish reading that trash entry.");
    }
    cursor = listing.cursor;
  }
  throw new FileOpError("FOLDER_TOO_LARGE", "That trash entry is too large to restore in one go.");
}

async function movePairs(
  store: FileStore,
  pairs: readonly { source: string; destination: string }[],
): Promise<void> {
  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${pair.destination}.`);
    }
  }
  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) throw notFound();
    await store.put(pair.destination, await object.arrayBuffer());
    await store.delete(pair.source);
  }
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
 * function thought it was. Saves used to leave the replaced version in
 * `.history/`, so any note that had ever been edited kept its content in the
 * bucket after being "permanently" deleted — invisible, because `isPlumbing`
 * hides it from the file tree and from every gateway tool, and unreachable,
 * because `canSee` refuses plumbing at every scope. A copy nobody can read is
 * still a copy: it is in the customer's bucket, it is in their storage bill,
 * and it is in the export their provider hands to whoever subpoenas it.
 *
 * **Nothing writes those snapshots now**, and the purge still runs, because the
 * argument above is about buckets rather than about code: every context
 * connected before the change is still full of them, and this is the only thing
 * that removes them. Delete the purge when no such bucket can exist, which is
 * not a date anyone can name.
 *
 * **What this function cannot reach is now the more important half.** Version
 * history is the customer's own object versioning, at their provider, and this
 * product actively tells them to turn it on. Where they did, the noncurrent
 * version survives this delete: we hold no `DeleteObjectVersion` capability we
 * can rely on across R2, S3, B2, Wasabi and Dropbox, and on several of them we
 * would need permissions the binding does not ask for. That is not a gap to
 * paper over — it is the customer's copy, in the customer's bucket, under the
 * customer's control, which is the arrangement this product is for. It does
 * mean the console must not promise erasure it cannot perform: see
 * `describeDeleteForever` in apps/mobile/features/console/files/paths.ts, which
 * names the condition instead.
 *
 * `confirmation` must be the literal `DELETE_CONFIRMATION`. A boolean flag
 * would be satisfied by any truthy value a buggy caller passed; a specific
 * string cannot be arrived at by accident.
 */
export async function deletePath(
  store: FileStore,
  options: { path: string; confirmation: string; clearance: Clearance; expectedEtag?: string },
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
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const targetIsFolder = await isFolder(store, path);
  if (options.expectedEtag !== undefined && targetIsFolder) {
    throw new FileOpError("PATH_INVALID", "Plugins may only delete files, not folders.");
  }
  if (options.expectedEtag !== undefined && store.capabilities?.conditionalDelete !== true) {
    throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely delete plugin files.");
  }
  const walk = targetIsFolder
    ? await keysUnder(store, path, options.clearance, state.rules, state.overrides)
    : { keys: [path], withheld: await namesExtending(store, path) };
  const keys = walk.keys;
  if (!targetIsFolder && (await store.get(path)) === null) throw notFound();
  // A folder holding nothing this caller can see is not a folder they can
  // empty. Answering `notFound()` is byte-identical to a folder that was never
  // there, where reporting "deleted 0 files" would say one is present.
  if (targetIsFolder && keys.length === 0) throw notFound();

  // Tombstone migrated plaintext notes before the legacy delete loop. This
  // retains their CRDT history for lifecycle accounting and prevents a stale
  // collaboration head from resurrecting the materialized Markdown later.
  const collaborationDeleted = new Set<string>();
  if (collaborationSupported(store)) {
    const candidates: string[] = [];
    for (const key of keys) {
      const object = await store.get(key);
      if (object === null) continue;
      const text = await object.text();
      if (!isEncryptedNote(text) && collaborationEligible(key, text)) candidates.push(key);
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely delete a collaboratively edited note.");
    }
    for (const key of candidates) {
      try {
        await tombstoneCollaborationDocument(store, key, {
          ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
          permanent: true,
        });
        collaborationDeleted.add(key);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
          throw new FileOpError("CONFLICT", "That file changed somewhere else while you were editing it.");
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely delete a collaboratively edited note.");
        }
        throw error;
      }
    }
  }

  for (const key of keys) {
    if (collaborationDeleted.has(key)) continue;
    const removed = options.expectedEtag === undefined
      ? await store.delete(key)
      : await store.delete(key, { onlyIf: { etagMatches: options.expectedEtag } });
    if (removed === null) {
      const current = await store.get(key);
      throw new FileOpError("CONFLICT", "That file changed somewhere else while the plugin was using it.", current?.etag);
    }
  }

  // The half that used to be missing. Deleting a folder purges its history
  // subtree in one go; deleting a file purges the snapshots that share its
  // name. Done after the live keys so a failure mid-purge leaves the bucket in
  // the state the *old* behaviour left it in — file gone, history behind —
  // rather than history gone and the file still sitting there.
  for (const key of await historyKeysFor(
    store,
    path,
    targetIsFolder,
    // `null` sweeps the whole subtree, orphans included, and that is a FOLDER
    // idea: everything under it is going, so a snapshot matched by nobody is
    // still this folder's. A single file has no subtree, and its neighbours'
    // names can extend its own, so it always names what it deleted and lets
    // longest match decide — otherwise an owner deleting `a.md` takes the
    // history of `a.md.notes.md`, which they never asked to delete.
    targetIsFolder && options.clearance.scope === "private" ? null : keys,
    walk.withheld,
  )) {
    await store.delete(key);
  }

  await forgetPrivacy(store, keys, targetIsFolder ? path : null, walk.withheld);

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
  /**
   * True when `folders` is not all of them — the walk hit the page cap, or a
   * folder was dropped because its name cannot be a manifest rule.
   *
   * One flag for both because the person's next move is the same either way:
   * anything missing has no line, so it inherits `default_visibility: private`
   * and can be given one by hand. The console says the list is short rather
   * than printing a count that reads like the whole bucket — the same rule
   * `noteCountTruncated` follows.
   */
  partial: boolean;
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
 *     changes hands.
 *
 *     This used to read "which is why `renderPrivacyManifestForFolders` takes
 *     no visibility argument", and that stopped being true when a shared
 *     context's scaffold learned to start its folders `team`: the function now
 *     takes a `ContextKind`, which is a visibility argument wearing a different
 *     noun. **The guarantee moved from the signature to this call site**, which
 *     passes no kind and so gets the `personal` default. Two tests fail the
 *     moment it passes `"shared"`, and `scaffold.ts` says beside the parameter
 *     that a call site adding one here is the bug — but nothing in the type
 *     stops it any more, so the reader of this paragraph is the guard.
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
 * frequently the case this whole feature is for, since a workspace synced from
 * Obsidian is exactly the kind that arrives with a hand-edited manifest — so
 * declaring `0-inbox … 4-archive` over somebody's `Journal/` and `Clients/`
 * would hand them a file with no line to edit for any folder they have. The
 * root walk is delimited and bounded like every other listing here; a bucket
 * too wide to finish gets the folders we saw and says the list is short, which
 * costs a line to add by hand and never costs visibility.
 */
export async function resetPrivacyManifest(
  store: FileStore,
  options: { clearance: Clearance; now: number },
): Promise<PrivacyResetResult> {
  if (options.clearance.scope !== "private") {
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

  const { folders, partial } = await rootFolders(store);
  const text = renderPrivacyManifestForFolders(folders);
  // The repair's whole job is to leave a file the parser accepts. Every folder
  // was checked individually above, so this cannot fire — which is exactly why
  // it is cheap to keep: if it ever does, the bucket is left broken as it was
  // rather than broken in a new way with the one exit spent.
  parsePrivacyManifest(text);

  let backedUpTo: string | null = null;
  if (state.text !== null) {
    // The copy keeps the name of the file it came from, and `.context/` is
    // plumbing that no listing shows either way.
    backedUpTo = `${RECOVER_PREFIX}${PRIVACY_KEY}.${timestampSlug(options.now)}.md`;
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

  return { path: PRIVACY_KEY, folders, backedUpTo, partial };
}

/**
 * The bucket's top-level folders, as far as they can be written down.
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
): Promise<{ folders: string[]; partial: boolean }> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let partial = false;

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: "", delimiter: "/", cursor, limit: 1000 });
    for (const raw of listing.delimitedPrefixes ?? []) {
      const folder = raw.replace(/\/+$/, "");
      if (!folder) continue;
      // `.history/`, `.audit/`, `.obsidian/`.
      if (isPlumbing(folder)) continue;
      if (!writableAsRule(folder)) {
        partial = true;
        continue;
      }
      seen.add(folder);
    }
    if (!listing.truncated) break;
    if (!listing.cursor) {
      partial = true;
      break;
    }
    cursor = listing.cursor;
    if (page === LIST_PAGE_CAP - 1) partial = true;
  }

  return { folders: [...seen].sort(), partial };
}

/**
 * Can this folder name be a line in `folder_defaults`?
 *
 * **A bucket key is far more permissive than a manifest rule, and nothing
 * guarantees a key came through our own path validation.** Obsidian's sync
 * plugin, rclone and the provider's web console all write keys directly, so
 * this function's input is arbitrary bytes that S3 accepted. Two ways that goes
 * wrong, and they fail in opposite directions:
 *
 *  - **A colon.** `parsePrivacyManifest`'s rule pattern is
 *    `^([^:]+?)\/?\s*:\s*(team|private)$`, so a folder called `2026: notes`
 *    produces a line the parser rejects — and one such folder would make the
 *    repair write a manifest that does not parse. The person's one exit from a
 *    broken manifest would leave it broken, with no second thing to try. (A `#`
 *    is the quieter version: the parser strips it as a comment, so the rule
 *    silently names a different folder.)
 *  - **A newline.** A legal S3 key character, and a name carrying one appends
 *    whatever it likes to `folder_defaults`. The useful thing to append is
 *    `: team`. That is a privilege escalation written into a folder name, and
 *    the manifest is the one file in the product where that lands.
 *
 * So the check is not a character blacklist — a blacklist is a guess about a
 * parser, and this one has a comment stripper, a trailing-slash tolerance and a
 * dot-segment rule. It **renders one rule and parses it back with the real
 * parser**, and accepts the folder only if exactly one rule comes out naming
 * exactly it. The oracle is the code that will read the file, so the two cannot
 * drift, and a future change to either is checked by construction.
 *
 * A folder that fails is left out of the manifest rather than blocking the
 * repair. It then has no rule, so it inherits `default_visibility: private` —
 * the fail-closed direction — and `partial` says the list is short.
 */
function writableAsRule(folder: string, vis: Visibility = "private"): boolean {
  try {
    const parsed = parsePrivacyManifest(
      renderPrivacyRulesBlock([{ prefix: folder, vis }], new Map()),
    );
    return (
      parsed.rules.length === 1 &&
      parsed.rules[0]!.prefix === folder &&
      parsed.rules[0]!.vis === vis &&
      parsed.overrides.size === 0
    );
  } catch {
    return false;
  }
}

/**
 * The same round trip for a NOTE OVERRIDE, which is the other half of the
 * format and the other half a caller supplies.
 *
 * `writableAsRule` existed and was correct, and guarded exactly one path —
 * `rootFolders`, the manifest *repair* routine. Neither visibility setter
 * reached it, and those are the two functions that take a caller-supplied path
 * and interpolate it into the file. A guard that cannot be reached from the
 * door the attacker uses is not a guard for that door.
 *
 * Why this is not redundant with `normalizePath`'s control-character refusal:
 * a blacklist is a guess about a parser that has a comment stripper, a
 * trailing-slash tolerance and a dot-segment rule. `2-areas/pay: team`
 * contains no control character at all, and renders a rule the parser reads as
 * naming `2-areas/pay` — a different note, silently. The oracle here is the
 * code that will actually read the file, so the two cannot drift.
 */
function writableAsOverride(path: string, vis: Visibility): boolean {
  try {
    const parsed = parsePrivacyManifest(
      renderPrivacyRulesBlock([], new Map([[path, vis]])),
    );
    if (parsed.rules.length !== 0 || parsed.overrides.size !== 1) return false;
    // Through `overrideFor`, like every other override read in this file: the
    // map has one entry so the case fold cannot change the answer, which is
    // exactly why reaching past the helper would be a harmless-looking
    // exception.
    return overrideFor(parsed.overrides, path) === vis;
  } catch {
    return false;
  }
}

/** What a path that cannot be written as a rule is told, at either setter. */
const UNWRITABLE_PATH_MESSAGE =
  "That path cannot be recorded in privacy.md: it contains a character the rule " +
  "format uses. Rename it and try again.";

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
/**
 * Set one path's visibility without asking whose hand it is.
 *
 * `setVisibility` is a caller's verb: it refuses anybody but the owner,
 * because rewriting `privacy.md` is the owner's alone. This is the product's
 * own, used for exactly one file — `activity.md`, which Context writes and
 * must keep private whatever folder default it lands under, because it names
 * paths from every corner of the context.
 *
 * Deliberately not exported through any action or operation. A second door
 * into the manifest that skips the clearance check is only safe while its one
 * caller is a constant, so the path is a parameter for testability and there
 * is exactly one value anything passes.
 */
export async function setExactVisibility(
  store: FileStore,
  path: string,
  visibility: Visibility,
): Promise<void> {
  await mutateManifest(store, (current) => ({
    rules: current.rules,
    overrides: nextOverrides(path, visibility, current.rules, current.overrides),
  }));
}

export async function setVisibility(
  store: FileStore,
  options: { path: string; visibility: Visibility; clearance: Clearance },
): Promise<VisibilityResult> {
  // Visibility writes rewrite `privacy.md`, the file that decides what every
  // non-owner may see — so only the owner's scope may reach them. The public
  // actions already require `owner`; this refusal is the layer that survives
  // a future caller getting that minimum wrong, the way the console once did.
  if (options.clearance.scope !== "private") {
    throw new FileOpError(
      "PATH_INVALID",
      "Only the owner of a context can change visibility.",
    );
  }
  const path = requirePath(options.path);
  assertWritablePath(path);
  if (!path.endsWith(".md")) {
    throw new FileOpError(
      "PATH_INVALID",
      "Only markdown notes can have their own visibility. Set the folder's default instead.",
    );
  }
  // Belt to `normalizePath`'s brace — see `writableAsOverride`.
  //
  // Placed AFTER the specific refusals, not before them: the parser enforces
  // the `.md` rule too, so a guard in front of that check would answer "that
  // path contains a character the rule format uses" for an ordinary folder and
  // quietly take over a message another check exists to give. A check added in
  // front of another makes the second one's tests vacuous.
  if (!writableAsOverride(path, options.visibility)) {
    throw new FileOpError("PATH_INVALID", UNWRITABLE_PATH_MESSAGE);
  }

  const state = await mutateManifest(store, (current) => {
    if (!canSee(path, options.clearance.scope, current.rules, current.overrides, options.clearance.names)) throw notFound();
    const overrides = nextOverrides(path, options.visibility, current.rules, current.overrides);
    return { rules: current.rules, overrides };
  });

  const inherited = visibilityOf(path, state.rules);
  // Re-derived, never echoed back: the request is what was asked for, and the
  // manifest is what happened. With the fold, those differ — a note whose
  // case-twin is private reads private however it was set — and reporting the
  // request would be the console saying a publish happened when it did not.
  const visibility = effectiveVisibility(path, state.rules, state.overrides);
  return {
    path,
    visibility,
    inherited,
    exception: visibility !== inherited,
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
  options: { path: string; visibility: Visibility; clearance: Clearance },
): Promise<VisibilityResult> {
  // Visibility writes rewrite `privacy.md`, the file that decides what every
  // non-owner may see — so only the owner's scope may reach them. The public
  // actions already require `owner`; this refusal is the layer that survives
  // a future caller getting that minimum wrong, the way the console once did.
  if (options.clearance.scope !== "private") {
    throw new FileOpError(
      "PATH_INVALID",
      "Only the owner of a context can change visibility.",
    );
  }
  const folder = requirePath(options.path);
  if (isPlumbing(folder)) throw new FileOpError("PATH_INVALID", "That path is reserved.");
  // Belt to `normalizePath`'s brace — see `writableAsOverride`.
  if (!writableAsRule(folder, options.visibility)) {
    throw new FileOpError("PATH_INVALID", UNWRITABLE_PATH_MESSAGE);
  }

  await mutateManifest(store, (current) => {
    if (
      options.clearance.scope !== "private" &&
      !folderVisibleAtScope(folder, options.clearance, current.rules, current.overrides)
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
    /** Notes the walk could not see, which stayed where they were. */
    survivors: readonly string[];
  },
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return; // nothing to keep in sync

  const touchesOverride = change.moves.some(({ from }) => hasOverride(state.overrides, from));
  const touchesRule =
    change.folderMove !== null &&
    state.rules.some(
      (rule) =>
        rule.prefix === change.folderMove!.from ||
        rule.prefix.startsWith(`${change.folderMove!.from}/`),
    );
  /*
    What each moved note was actually visible as, which is a different question
    from whether it had an exception — and the difference is the whole of this
    block.

    A note is usually private because its FOLDER is, with nothing in the
    manifest naming the note at all. That fact does not travel with it: carry
    only the exceptions and the inherited case lands on the destination's rule,
    so dragging a note out of a private folder into a shared one published it,
    to exactly the people the folder was private from. `movePath`'s own header
    has always said this must not happen; it said it about the exception, which
    is the case that was handled.

    The gateway has narrowed a move against its destination since `move_note`
    was written — `narrowerVisibility(sourceVisibility, visibilityOf(destination))`
    — and this is that rule on this side of the platform split, computed from
    the manifest as it was BEFORE the move.
  */
  const wasVisibleAs = new Map<string, Visibility>();
  for (const move of change.moves) {
    wasVisibleAs.set(move.from, effectiveVisibility(move.from, state.rules, state.overrides));
  }
  const mayWiden = change.moves.some((move) => wasVisibleAs.get(move.from) === "private");
  if (!touchesOverride && !touchesRule && !mayWiden) return;

  await mutateManifest(store, (current) => {
    const rules = [...rulesAfterFolderMove(current.rules, change.folderMove)];
    // The renamed set describes where the moved notes went. Anything a note
    // left behind still depends on has to stay where that note is.
    if (change.folderMove !== null) {
      rules.push(
        ...rulesSurvivorsRestOn(
          current.rules,
          rules,
          current.overrides,
          change.survivors,
          change.folderMove.from,
        ),
      );
    }
    /*
      A folder that was private only because its parent was needs ONE rule at
      the destination, not an exception per note: a 500-note folder would
      otherwise write 500 lines into a customer's `privacy.md` to say what one
      line says. `rulesAfterFolderMove` has already carried a rule the folder
      owned itself, so this fires only where the folder owned none.
    */
    if (change.folderMove !== null) {
      const ownsRule = current.rules.some((rule) => rule.prefix === change.folderMove!.from);
      const inherited = visibilityOf(change.folderMove.from, current.rules);
      if (!ownsRule && inherited === "private" && visibilityOf(change.folderMove.to, rules) === "team") {
        rules.push({ prefix: change.folderMove.to, vis: inherited });
      }
    }
    const deduped = oneRulePerPrefix(rules);
    let overrides = current.overrides;
    for (const move of change.moves) {
      overrides = movedOverrides(move.from, move.to, deduped, overrides);
      // Only where the note had no exception of its own: `movedOverrides` has
      // already re-derived that case against the destination, and re-deriving
      // it a second time here would quietly retier an owner's deliberate
      // exception. `nextOverrides` writes nothing where the destination folder
      // already gives the note what it had, so a move that widens nothing
      // leaves the manifest untouched.
      if (hasOverride(current.overrides, move.from)) continue;
      const was = wasVisibleAs.get(move.from);
      if (was === undefined) continue;
      // `narrowerVisibility` is typed for two optional arguments, so it answers
      // optionally; both of these are present, and the guard says so rather
      // than asserting it.
      const carry = narrowerVisibility(was, visibilityOf(move.to, deduped));
      if (carry === undefined) continue;
      overrides = nextOverrides(move.to, carry, deduped, overrides);
    }
    return { rules: deduped, overrides };
  });
}

/**
 * Give a copy what its original had — its exception where it had one, and
 * otherwise the visibility its folder gave it.
 *
 * The second half is the same fact `remapPrivacy` turns on, and it is not the
 * rarer half: a note is usually private because its FOLDER is, with nothing in
 * the manifest naming the note. Carrying only exceptions meant a copy taken
 * into a shared folder arrived readable by every member, and the copy is the
 * operation where that is hardest to notice — the original is still sitting
 * where it was, still private, so nothing the owner is looking at changed.
 *
 * Narrowed against the destination, never widened, exactly as a move is.
 */
async function copyPrivacy(
  store: FileStore,
  pairs: { from: string; to: string }[],
  folderCopy: { from: string; to: string } | null = null,
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;
  const wasVisibleAs = new Map<string, Visibility>();
  for (const pair of pairs) {
    wasVisibleAs.set(pair.from, effectiveVisibility(pair.from, state.rules, state.overrides));
  }
  const carriesSomething = pairs.some(
    ({ from }) => hasOverride(state.overrides, from) || wasVisibleAs.get(from) === "private",
  );
  if (!carriesSomething) return;

  await mutateManifest(store, (current) => {
    // One rule for a copied folder that was private only because its parent
    // was, for `remapPrivacy`'s reason: an exception per note turns a
    // customer's `privacy.md` into a list of everything they ever copied.
    const rules = [...current.rules];
    if (folderCopy !== null) {
      const inherited = visibilityOf(folderCopy.from, current.rules);
      if (inherited === "private" && visibilityOf(folderCopy.to, current.rules) === "team") {
        rules.push({ prefix: folderCopy.to, vis: inherited });
      }
    }
    const deduped = oneRulePerPrefix(rules);
    let overrides = current.overrides;
    for (const pair of pairs) {
      const existing = overrideFor(current.overrides, pair.from);
      const was = wasVisibleAs.get(pair.from);
      // An exception is carried as it stands — the owner chose it, and
      // re-deriving it here would retier that choice. Only the inherited case
      // is computed, and `nextOverrides` writes nothing where the destination
      // folder already gives the copy what the original had.
      const carry =
        existing ?? (was === undefined ? undefined : narrowerVisibility(was, visibilityOf(pair.to, deduped)));
      if (carry === undefined) continue;
      overrides = nextOverrides(pair.to, carry, deduped, overrides);
    }
    return { rules: deduped, overrides };
  });
}

/** Drop rules for things that no longer exist. */
async function forgetPrivacy(
  store: FileStore,
  keys: string[],
  deletedFolder: string | null,
  /** Notes the walk could not see, which were not deleted. */
  survivors: readonly string[],
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;

  const keyHasOverride = keys.some((key) => hasOverride(state.overrides, key));
  const hasRule =
    deletedFolder !== null &&
    state.rules.some(
      (rule) => rule.prefix === deletedFolder || rule.prefix.startsWith(`${deletedFolder}/`),
    );
  if (!keyHasOverride && !hasRule) return;

  await mutateManifest(store, (current) => {
    let overrides = current.overrides;
    for (const key of keys) overrides = clearedOverrides(key, overrides);
    let rules = current.rules;
    if (deletedFolder !== null) {
      const dropped = current.rules.filter(
        (rule) =>
          rule.prefix !== deletedFolder && !rule.prefix.startsWith(`${deletedFolder}/`),
      );
      // A rule a surviving note's visibility rests on is not this folder's to
      // forget — the note is still here and still needs it.
      rules = dropped.concat(
        rulesSurvivorsRestOn(current.rules, dropped, current.overrides, survivors, deletedFolder),
      );
    }
    return { rules, overrides };
  });
}

/* -------------------------------------------------------------------------- */
/*                          writing something that is not a note              */
/* -------------------------------------------------------------------------- */

/**
 * The most one stored image may be.
 *
 * Deliberately its own number rather than `MAX_NOTE_BYTES`. They are the same
 * today and mean different things: one bounds a document a person typed, the
 * other bounds bytes a machine produced, and tying them together means changing
 * the note limit silently changes what a bucket may be made to hold.
 */
export const MAX_STORED_IMAGE_BYTES = 5_000_000;

/**
 * Where objects that are not notes live: `.images/`, opaque and unlistable.
 *
 * Dot-prefixed, so `isPlumbing` hides it from every listing, every search and
 * Obsidian itself. That opacity is the point of the location — see the comment
 * on `IMAGE_PREFIX` in the gateway, which reads the same store from the other
 * side.
 */
export { IMAGE_PREFIX };

/**
 * The leaf extensions `read_image` will serve back.
 *
 * The gateway's `IMAGE_MIME_TYPES` keys, restated rather than imported for the
 * same reason the character class below is: `apps/mcp` is dependency-free by
 * design, so the two cannot share a module. **`writeImage.test.ts` reads the
 * gateway's source and fails on drift** — and until now that arrangement was
 * claimed here and did not exist, which is why this list is the second half of
 * a rule that had only ever had its first half enforced.
 *
 * SVG is absent, deliberately and on both sides: it is a script container, and
 * a store that accepted one would make the gateway's refusal to serve one moot.
 */
export const STORABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "heif",
]);

/**
 * Write bytes into the opaque store.
 *
 * A deliberately different function from `writeFile`, not an option on it, and
 * the differences are all the reasons it exists:
 *
 *  - **No `.md`, no `privacy.md` check, no visibility check.** An image has no
 *    visibility of its own — it borrows the visibility of whatever note
 *    references it, which is what keeps it from drifting out of sync with the
 *    access map. Asking `canSee` about a key under `.images/` would be asking a
 *    question the manifest has no answer to, and inventing one is how the two
 *    start disagreeing.
 *  - **No history.** `.history/` exists so a person can recover a document they
 *    edited. These keys are content-addressed: a different image is a different
 *    key, so there is no previous version of one to keep.
 *  - **No conditional write.** For the same reason. Writing the same key twice
 *    is writing the same bytes twice.
 *
 * What it does enforce is the shape of the key and the type of the object,
 * because this is the one write path that can put a non-note in a customer's
 * bucket. The leaf rule is the gateway's, deliberately: a key this writes and
 * `read_image` cannot name is bytes nobody can ever get back out.
 *
 * **That rule had one of its FOUR gates.** `imageRefFor` refuses an empty
 * value, one over 512 characters, a `\`, or a `..` anywhere in the raw value;
 * then requires the character class below; then a `.` past position 0; then an
 * extension in `IMAGE_MIME_TYPES`. Only the
 * character class was enforced here, so `writeImage` would happily resolve for
 * `abc`, `abc.txt` and `abc.svg` — measured, returning
 * `{ key: ".context/assets/images/abc" }`
 * — every one of which `read_image` refuses forever.
 *
 * (An earlier version of this comment said "two halves" and enumerated three
 * gates as the whole rule. It omitted `..`, and the code omitted it too, so
 * `a..png` and `abc..jpeg` still resolved and still wrote bytes the gateway
 * would never hand back. A comment that enumerates somebody else's rule is a
 * claim about their code, and this one was made by reading three lines of
 * four.)
 * Latent rather than live: this function has no production call site. Which is
 * a fact about today, and the reason to close it now rather than when one
 * appears.
 */
export async function writeImage(
  store: FileStore,
  options: { leaf: string; bytes: Uint8Array; contentType: string },
): Promise<{ key: string; etag: string }> {
  const leaf = options.leaf;
  // The gateway's rule, restated rather than imported: `apps/mcp` is
  // dependency-free by design, so the two cannot share a module. A test reads
  // the gateway's source and fails on drift — the same arrangement
  // `MAX_INLINE_IMAGE_BYTES` already has. (It says so now. When this comment
  // was first written it named a test that did not exist, for either half of
  // the rule below.)
  // `..` first, as the gateway does: it survives the character class, because
  // `.` is inside that class, so nothing below would catch it.
  //
  // The gateway's first line also refuses an empty value, a `\`, and anything
  // over 512 characters. All three are subsumed here — empty and `\` by the
  // character class, 512 by the stricter 200 — which is a claim a fuzz over
  // 18,277 leaves against the gateway's own extracted `imageRefFor` bears out:
  // zero inputs this accepts and the gateway refuses. Said explicitly because
  // the comment above is about enumerating a rule by reading part of it.
  if (
    leaf.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf) ||
    leaf.length > 200
  ) {
    throw new FileOpError("PATH_INVALID", "That is not a valid stored-object name.");
  }
  // The last two gates. `imageRefFor` resolves the mime type from the
  // extension, so a leaf without one, or with one the gateway cannot serve,
  // names an object no tool can ever return.
  //
  // `dot <= 0` is not a subsumed backstop and is pinned by its own case: with
  // it gone, `slice(-1 + 1)` is the whole leaf, so a leaf that IS an extension
  // name — `png`, `jpeg` — passes the set lookup and writes `.images/png`,
  // which `imageRefFor` refuses because it finds no dot at all.
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || !STORABLE_IMAGE_EXTENSIONS.has(leaf.slice(dot + 1).toLowerCase())) {
    throw new FileOpError(
      "PATH_INVALID",
      "A stored object must end in an image extension the gateway can serve.",
    );
  }
  if (options.bytes.byteLength === 0) {
    throw new FileOpError("CONTENT_TOO_LARGE", "There is nothing to store.");
  }
  if (options.bytes.byteLength > MAX_STORED_IMAGE_BYTES) {
    throw new FileOpError(
      "CONTENT_TOO_LARGE",
      `A stored image must be at most ${MAX_STORED_IMAGE_BYTES} bytes.`,
    );
  }

  const key = `${IMAGE_PREFIX}${leaf}`;
  // `assertWritableContentType` in the store layer is the authority and will
  // refuse anything outside the allow-list; this is not a second guess at it,
  // only the value being passed through.
  const put = await store.put(key, options.bytes, { contentType: options.contentType });
  if (put === null) {
    // `null` is the conditional-write refusal, and this write is not
    // conditional — so reaching it means the adapter's contract changed under
    // us. `CONFLICT` is the honest code: something else wrote that key.
    throw new FileOpError("CONFLICT", "Your bucket did not accept that write.");
  }
  return { key, etag: put.etag };
}

/**
 * Read bytes back out of the opaque store.
 *
 * The mirror of `writeImage`, and exempt from the same three rules for the same
 * reasons: no `.md`, no manifest, no history. **It applies the identical leaf
 * check**, which is what stops it being a general object reader — the same
 * property `read_image` in the gateway is built around. Without it, a caller
 * naming `../privacy.md` would walk straight out of `.images/` and hand back
 * the access map.
 *
 * Missing is `FILE_NOT_FOUND`, the same code an invisible note gets, so a
 * caller cannot tell "no card yet" from "never existed".
 */
export async function readImage(store: FileStore, leaf: string): Promise<ArrayBuffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf) || leaf.length > 200) {
    throw new FileOpError("PATH_INVALID", "That is not a valid stored-object name.");
  }
  const key = `${IMAGE_PREFIX}${leaf}`;
  const legacyKey = legacyStorageKey(key);
  const object = (await store.get(key)) || (legacyKey ? await store.get(legacyKey) : null);
  if (object === null) throw notFound();
  // `arrayBuffer` rather than `text`: a PNG decoded as UTF-8 is mojibake, and
  // the adapters that predate images only guaranteed `text`.
  const reader = object as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof reader.arrayBuffer !== "function") {
    // Every real adapter has it; the narrow `ScaffoldStore` type predates
    // images and only promises `text`. `FILE_NOT_FOUND` rather than a new code:
    // from the caller's side a store that cannot hand back bytes and a card
    // that was never written are the same absence, and both mean "serve the
    // static card".
    throw notFound();
  }
  return await reader.arrayBuffer();
}

/* -------------------------------------------------------------------------- */
/*                      an image somebody pasted into a note                   */
/* -------------------------------------------------------------------------- */

/**
 * The leaf a pasted image is stored under, inside `IMAGE_PREFIX`.
 *
 * **It goes in the opaque store with everything else, and that reverses the
 * first version of this feature**, which put pastes in a visible
 * `attachments/<YYYY>/<MM>/` folder so the embed would resolve in Obsidian. The
 * owner's call, and the reasons are good ones: one image store rather than two,
 * nothing new in the listing, the file tree stays the customer's own folders,
 * and `read_image` already serves this prefix — so an agent can fetch a pasted
 * image, which the visible folder could not offer without widening
 * `imageRefFor`. What it costs is stated rather than hidden: Obsidian skips
 * dot-folders, so the embed draws as a broken link there until this product
 * writes an Obsidian-side resolver or the file is exported.
 *
 * The name is the content hash, which buys the same three things it always did:
 * the same paste in three notes is one object, a retried upload overwrites
 * itself rather than leaving `-1` behind, and a clipboard with no filename needs
 * no invented one. `paste-` in front so a person looking at the store can see
 * where an object came from, and because `writeImage`'s leaf rule wants an
 * alphanumeric first character.
 */
const PASTE_EXTENSIONS = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

export function pasteImageLeaf(options: { hash: string; contentType: string }): string {
  const extension = PASTE_EXTENSIONS.get(options.contentType);
  if (extension === undefined) {
    throw new FileOpError("PATH_INVALID", "That is not an image type this store accepts.");
  }
  const hash = options.hash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 16);
  if (hash.length < 8) {
    throw new FileOpError("PATH_INVALID", "A stored image needs a content hash for its name.");
  }
  return `paste-${hash}.${extension}`;
}

/**
 * The leaf a workspace's icon photo is stored under, inside `IMAGE_PREFIX`.
 *
 * The same store as a paste and a different prefix, for the reason `paste-`
 * has one: somebody reading the objects in their own bucket can see where each
 * came from. It is not a namespace and nothing resolves on it — `readImage`
 * takes leaves, not patterns — so the prefix is a label and the content hash is
 * still what names the object.
 *
 * Content-addressed like a paste, and the same three things follow: setting the
 * same photo on two workspaces writes one object, a retried upload overwrites
 * itself, and a picker result with no filename needs no invented one.
 *
 * **The type list is narrower than `PASTE_EXTENSIONS`** and that is the
 * difference worth stating: `WORKSPACE_ICON_EXTENSIONS` drops `gif`, `heic` and
 * `heif`, because an icon has to draw in a browser and two of those do not. It
 * is imported from `@context/shared` rather than restated, because the picker
 * pre-flights the same rule before it uploads and two copies of it would be a
 * picker offering what this refuses; see its own note for why each type is out.
 */
export function workspaceIconLeaf(options: { hash: string; contentType: string }): string {
  const extension = WORKSPACE_ICON_EXTENSIONS.get(options.contentType);
  if (extension === undefined) {
    throw new FileOpError("PATH_INVALID", "That is not an image type an icon can be stored as.");
  }
  const hash = options.hash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 16);
  if (hash.length < 8) {
    throw new FileOpError("PATH_INVALID", "A stored image needs a content hash for its name.");
  }
  return `icon-${hash}.${extension}`;
}

/** One console search result: a path the caller may see, and lines from it. */
export interface SearchHit {
  path: string;
  title: string;
  snippets: string[];
}

export interface SearchResults {
  hits: SearchHit[];
  /** Visible matches found, which may exceed the hits returned. */
  matchCount: number;
  /** `matchCount` is a floor: the ranked list was full, or a walk was cut short. */
  matchCountIsFloor: boolean;
  /** The index has not caught up with the bucket, so results may be short. */
  indexIncomplete: boolean;
  /**
   * There was no index to answer from at all.
   *
   * Never collapsed into "no matches": a bucket nothing has indexed yet would
   * then tell somebody their note does not exist, which is the failure this
   * whole feature exists to remove. The gateway answers this case with a
   * literal scan it can afford inside one Worker invocation; the console says
   * the context is still being indexed and leaves its own filename filter
   * standing.
   */
  indexMissing: boolean;
  /**
   * Some of this caller's own visible notes lost per-message recall to the
   * search index's own capacity, and never resolves by searching again — the
   * opposite claim from `indexIncomplete`, which is why it is a separate
   * field rather than folded into it (`docs/decisions/search.md`, sizing
   * section). `false` for the D1 projection path: a chunk row per message has
   * no shard byte cap for a mailbox to cross, so this is a fact about the R2
   * shard index alone.
   */
  reducedRecall: boolean;
  /**
   * Which of the caller's own visible notes those are — already filtered
   * through this scope's `canSee`, the same as every path in `hits`, and safe
   * to render for that reason. A note's own path names the channel and day
   * (`0-inbox/email/<address>/2026-09-07.md`), which is what makes this
   * actionable rather than a bare count.
   */
  reducedRecallNotes: string[];
}

/**
 * Search the notes this scope can see, from the derived index in the
 * customer's own bucket.
 *
 * **This runs the gateway's search, imported, rather than a port of it.**
 * `searchIndexedNotes` is the same function `search_notes` answers from, so
 * the console and an AI client cannot disagree about what a query matches or
 * about who may see a hit — CLAUDE.md's "one search path" rule, extended to a
 * third caller. What is passed in is this runtime's own `canSee` and
 * `isPlumbing`, which `__tests__/privacyEngine.test.ts` already proves answer
 * identically to the gateway's for every manifest, key and scope it is given.
 *
 * The subrequest budget the gateway sets exists because Cloudflare caps
 * subrequests per invocation; a Convex action has no such cap, so this passes
 * a larger one — a console search on a cold bucket then makes real progress on
 * the backfill instead of nibbling at it, and the same index serves both
 * surfaces afterwards.
 *
 * **A search does not maintain the index**, and that is the change that took a
 * console search over a real workspace from twenty-odd seconds to a fraction of
 * one. It reads a manifest, the shards this query's terms can be in, and the
 * notes it is quoting. `searchContext` schedules `maintainSearchIndex` behind
 * the answer when the answer says the index is behind.
 *
 * ## And the projection first, where this context has a complete one
 *
 * `answerFromProjection` is imported for exactly the reason `searchIndexedNotes`
 * is, and it is the same rule: everything below the D1 query is a privacy
 * boundary — which rows a caller keeps, whether the count is taken before or
 * after that filter, whether an empty result is an answer — and a second copy
 * of those decisions in this file would be a second place for each of them to
 * be wrong. What is injected is this runtime's own `canSee`, bound to the
 * caller's scope, exactly as it is into `searchIndexedNotes` below.
 *
 * `null` from it means **not answered** and never "no results": a projection
 * is a disposable derivative that can be behind, and reporting its silence as
 * an empty context is the failure this whole surface is built to avoid. So a
 * miss costs the R2 answer as well and the person waits what they waited
 * before; only a hit is fast. That is what makes it safe to consult on every
 * search rather than behind a second switch.
 *
 * `projection` is `null` unless the caller opened one, which it does only for
 * a row the control plane calls `ready` — the same gate the gateway applies,
 * because a projection that is still filling answers a query about a note it
 * has not copied with a silence this path would read as a miss.
 *
 * The one exception is `refreshOnMiss`, and it is the reason a member's search
 * can still cause a write under `.index/` whatever their role — worth saying
 * out loud beside a module whose every other write is gated on `canEdit`. It is
 * not an escalation and it is not new: an AI client on a team-tier grant
 * maintains this index too, the keys are plumbing rather than note content, and
 * the whole thing is a disposable derivative a person's own notes can rebuild.
 * What a member must not be able to do is *read* more than their scope, and
 * that is `isVisible`, below.
 */
/**
 * Every note path this scope may see, for link resolution in the editor —
 * `docs/decisions/app-and-console.md`, "L1".
 *
 * A bare `[[name]]` and the `[[` completion both need the whole bucket's note
 * paths, and the console's file tree only knows the folders somebody has
 * expanded. Rather than a second index — a full bucket listing paid for on
 * the customer's request quota, which is exactly the cost
 * `1-projects/context-lc-search-performance/overview.md` spent Phase 2
 * removing from the search path — this reads the search index's own docmap,
 * which is already maintained behind every search's response.
 *
 * **Filtered through the caller's own `canSee`, the same as every hit a
 * search returns.** The docmap holds every note in the bucket regardless of
 * who asks, so skipping this filter would leak a private note's *existence* —
 * its path — to a team member who could not open it, through a completion
 * list rather than a listing. That is exactly the existence oracle rule #2 at
 * the top of this file exists to prevent, reached through a different door.
 *
 * `null` for every way the index is not there to answer from — nothing has
 * indexed this bucket, the docmap could not be read, no budget was left —
 * and deliberately not a partial or wrong answer instead: a link that stays
 * undrawn until the index catches up is dishonest about *timing*, never about
 * *destination*.
 */
export async function notePathIndex(
  store: FileStore,
  clearance: Clearance,
  budget: number = CONSOLE_SEARCH_BUDGET,
): Promise<{ paths: string[] } | null> {
  const state = await loadPrivacyState(store);
  const isVisible = (path: string) =>
    canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  const found = await loadDocmapPaths(
    store as unknown as Parameters<typeof loadDocmapPaths>[0],
    createSearchBudget(budget),
    0,
  );
  if (found === null) return null;
  return { paths: found.paths.filter((path) => isVisible(path) && !isPlumbing(path)) };
}

export async function searchNotes(
  store: FileStore,
  options: {
    query: string;
    prefix?: string;
    clearance: Clearance;
    budget?: number;
    /**
     * How far down the ranked list to read, in notes.
     *
     * Ten by default, which is the palette every caller had before the search
     * page existed. `pageDepth` is the shared clamp and the ceiling is
     * `MAX_RESULTS`, where the *ranking* is cut — see its comment in
     * `search/d1/serve.js` for why a deeper page is a deeper slice of the same
     * list rather than a second query with an offset.
     */
    limit?: number;
    /**
     * Whether an empty answer may buy one bucket listing and ask again.
     *
     * True for a single-context search, which is the case `searchIndexedNotes`
     * wrote the rule for: somebody wrote a note a minute ago and is looking for
     * it, and one listing is worth not telling them it does not exist.
     *
     * **A fan-out across contexts passes false**, and the arithmetic is the
     * reason. The rule costs one listing per *miss*, and a blended search over
     * eight contexts misses in most of them by construction — a word that is in
     * one workspace is absent from the other seven. That is seven full bucket
     * listings, on seven customers' request quotas, for one keystroke's worth
     * of scrolling, and it would make the fan-out's worst case its ordinary
     * case. The honesty the rule buys is not lost: a source whose index is
     * behind still says so, per source, and the page renders that rather than
     * "no matches".
     */
    refreshOnMiss?: boolean;
  },
  projection: ProjectionClient | null = null,
): Promise<SearchResults> {
  const query = options.query.trim();
  if (query === "") {
    return {
      hits: [],
      matchCount: 0,
      matchCountIsFloor: false,
      indexIncomplete: false,
      indexMissing: false,
      reducedRecall: false,
      reducedRecallNotes: [],
    };
  }

  const folder = options.prefix ? requireFolderPath(options.prefix) : "";
  const state = await loadPrivacyState(store);
  // A folder this scope cannot open is not a narrower search, it is a folder
  // that does not exist — the same answer `listFolder` gives, so a prefix
  // cannot become a way to ask whether a hidden folder has anything in it.
  if (folder !== "" && !folderVisibleAtScope(folder, options.clearance, state.rules, state.overrides)) {
    throw notFound();
  }

  const isVisible = (path: string) =>
    canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names);

  // Clamped once, here, and handed to both index paths — a page depth that the
  // projection honoured and the R2 index did not would make the number of
  // results depend on which derivative answered, which is the one difference
  // between them a caller must never be able to see.
  const limit = pageDepth(options.limit);

  if (projection !== null) {
    try {
      const fast = await answerFromProjection(projection, {
        query,
        prefix: folder,
        tier: options.clearance.scope,
        isVisible,
        limit,
      });
      if (fast) {
        return {
          hits: fast.hits.map((hit: { key: string; title: string; snippets: string[] }) => ({
            path: hit.key,
            title: hit.title,
            snippets: hit.snippets,
          })),
          matchCount: fast.matchCount,
          matchCountIsFloor: fast.matchCountIsFloor,
          // The projection is filled from the R2 index's own docmap, so a note
          // that index has not reached is a note the projection cannot hold
          // either. Reading the manifest to say so would cost the object read
          // this path exists to avoid, and the answer it would give is the one
          // the caller gets on its next miss anyway — so this reports what it
          // knows, which is that the answer came from a complete projection.
          indexIncomplete: false,
          indexMissing: false,
          // `false`, unconditionally: the projection holds one row per message
          // with no shard byte cap for a mailbox to cross, so a channel-day
          // note is never reduced here the way it can be in the R2 index. See
          // `SearchResults.reducedRecall`.
          reducedRecall: false,
          reducedRecallNotes: [],
        };
      }
    } catch {
      // Every D1 failure is one of `d1/client.js`'s closed-set codes, and none
      // is a reason to fail a search somebody is watching a spinner for: the
      // R2 index answers below exactly as it does with fast search off. A bare
      // catch also swallows a bug in this block, which is the honest cost of
      // that rule — the alternative is a console search that fails outright
      // when it had a good answer one call away.
    }
  }

  const found = await searchIndexedNotes(store as unknown as SearchStore, {
    isVisible,
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
    query,
    prefix: folder,
    limit,
    budget: createSearchBudget(options.budget ?? CONSOLE_SEARCH_BUDGET),
    // A person typed this and is watching a spinner, which is exactly who the
    // rule is for: a miss over an index that believes it is converged buys one
    // listing and asks again, and an answer with hits in it buys nothing. The
    // console is where somebody writes a note and then looks for it, so the
    // case this covers — the index is current as of a minute ago and the note
    // is newer than that — is the console's own most likely miss.
    //
    // A fan-out turns it off; see `refreshOnMiss` in the options above.
    refreshOnMiss: options.refreshOnMiss ?? true,
  });

  if (!found.indexed) {
    return {
      hits: [],
      matchCount: 0,
      matchCountIsFloor: false,
      indexIncomplete: false,
      indexMissing: true,
      reducedRecall: false,
      reducedRecallNotes: [],
    };
  }

  return {
    hits: (found.hits ?? []).map((hit) => ({
      path: hit.key,
      title: hit.title,
      snippets: hit.snippets,
    })),
    matchCount: found.matchCount ?? 0,
    matchCountIsFloor: Boolean(found.matchCountIsFloor),
    indexIncomplete: Boolean(found.indexIncomplete),
    indexMissing: false,
    reducedRecall: Boolean(found.reducedRecall),
    reducedRecallNotes: found.reducedRecallNotes ?? [],
  };
}

/**
 * One pass of the R2 shard index, over a budget the caller owns.
 *
 * The one place that knows what an indexing pass *is* — which keys count as
 * notes, and that it is `syncShardedIndex` and not something of ours. Both
 * callers below share it so they cannot come to disagree about either: a
 * background indexer with its own notion of `isIndexable` is a second place
 * for the index to be wrong, in the way a second search path would be a second
 * place for a visibility bug.
 *
 * It takes the budget rather than a number because the projection spends from
 * the same one — the listing, the note reads and the D1 statements are one
 * pass's worth of work, and two allowances would mean neither bounded it.
 */
async function runIndexPass(
  store: FileStore,
  budget: ReturnType<typeof createSearchBudget>,
  reserve = 0,
  /**
   * Test-only injection, exactly as `syncShardedIndex` itself documents:
   * nothing in production passes this, and `maintainSearchIndex` does not
   * accept it from its own caller. Real shedding needs a shard's serialized
   * body to cross `SHARD_PARSE_BYTE_CAP` (2MB), which a unit test proving the
   * *plumbing* through this file — as opposed to the sizing mechanism itself,
   * already exhaustively covered in `apps/mcp/test/commsSearchIndex.test.mjs`
   * — should not have to build megabytes of Markdown to reach.
   */
  shardByteCap?: number,
) {
  return await syncShardedIndex(store as unknown as Parameters<typeof syncShardedIndex>[0], {
    budget,
    reserve,
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
    ...(shardByteCap === undefined ? {} : { shardByteCap }),
  });
}

/**
 * Bring the search index a pass further. Nobody is waiting on this.
 *
 * A console search reads a ready index and maintains nothing, so this is the
 * whole of the console's half of index maintenance — a full listing of the
 * bucket, an etag diff, the notes that changed re-read, the shards they belong
 * to rewritten. It used to happen in front of the person asking the question,
 * which is what made a search over a real workspace take twenty seconds and
 * sometimes fail on a ten-second fetch deadline partway through.
 *
 * It is reached through the same credential barrier every other file operation
 * goes through, and **scheduled** rather than called: `searchContext` enqueues
 * it after answering, which propagates no taint (CLAUDE.md, "Scheduling is not
 * calling") and hands the caller nothing to wait for.
 *
 * It is the same `syncShardedIndex` the gateway runs, not a second maintenance
 * path. A background indexer with its own diff would be a second place for the
 * index to be wrong, in the way a second search path would be a second place
 * for a visibility bug.
 *
 * **It reads every note in the bucket, private ones included, and answers
 * nothing about them.** The return carries counts of the index's own progress
 * and no path, no title and no term — an indexing pass is scope-blind by
 * construction (`isIndexable`, never `isVisible`), and the moment one could
 * report *which* notes it touched it would be an existence oracle for the
 * private half of somebody's bucket.
 */
export async function maintainSearchIndex(
  store: FileStore,
  /** `shardByteCap` is test-only — see `runIndexPass`. */
  options: { budget?: number; shardByteCap?: number } = {},
): Promise<{ pending: number; changed: boolean; complete: boolean; shed: number; oversizedShards: number }> {
  const pass = await runIndexPass(
    store,
    createSearchBudget(options.budget ?? INDEX_SYNC_BUDGET),
    0,
    options.shardByteCap,
  );
  return {
    pending: pass.pending,
    // `committed`, not `changed`: a pass whose manifest write lost a race to a
    // concurrent one did work the winner is about to re-derive, and the chain
    // below must not treat that as progress. Otherwise every search in a burst
    // schedules twelve more passes over the same notes.
    changed: Boolean(pass.committed),
    // "Nothing left to do", which is what decides whether another pass is
    // scheduled behind this one. A truncated listing counts as incomplete for
    // the same reason it does everywhere else here: a walk that was cut short
    // is not evidence that there was nothing more to find.
    complete: pass.pending === 0 && !pass.listingTruncated && !pass.manifestOverflow,
    // `pending`'s opposite, in the same no-path-no-title-no-term shape every
    // other count on this return already follows: a scalar over the whole
    // bucket, private notes included, for the operator rather than any one
    // caller — `searchNotes`'s own `reducedRecallNotes` is the caller-safe,
    // per-scope answer to the same fact. This pass's own count, not the
    // index's running total: a shard nothing changed this pass is not
    // reopened, so a note shed earlier and untouched since is not recounted
    // here every pass — see `docs/decisions/search.md`, sizing section.
    shed: pass.shed.length,
    oversizedShards: pass.oversizedShards,
  };
}

/* -------------------------------------------------------------------------- */
/*                             the D1 projection                              */
/* -------------------------------------------------------------------------- */

/**
 * Store operations one scheduled projection pass may spend.
 *
 * Larger than `INDEX_SYNC_BUDGET` because this pass does that pass's work
 * *and* the copy behind it: a listing, an etag diff, the notes that moved
 * re-read, the shards rewritten, and then a note read plus six statements per
 * note projected. Cloudflare's per-invocation subrequest cap is what bounds
 * the gateway's equivalent; there is no such cap here, and nobody is waiting.
 */
const PROJECTION_PASS_BUDGET = 1_200;

/**
 * Ops one pass keeps back for the projection **before the R2 sync spends
 * anything**, as a share rather than a fixed number.
 *
 * A quarter, which is the gateway's own measured figure and is copied for the
 * reason it was measured: at a half, a small bucket's index could not build at
 * all — every pass spent its allowance on the listing and had nothing left to
 * read a note with. A reserve that starves the index it is riding is worse
 * than no reserve, and the census this pass walks *is* that index.
 *
 * A reserve taken out of what the previous stage happened to leave is not a
 * reserve, so it is settled before the sync is called.
 */
const PROJECTION_RESERVE_SHARE = 4;

/**
 * Notes one pass may copy.
 *
 * `VERSION_PROBE_CAP` in `d1/backfill.js` bounds the window to 100 paths, so
 * asking for more than that cannot buy more; asking for the gateway's 20 would
 * leave three quarters of an affordable pass unspent. The budget is the real
 * bound either way.
 */
const PROJECTION_NOTE_CAP = 100;

/**
 * The part of the gateway's D1 client this needs, and nothing more.
 *
 * Structural rather than an import of `createD1Client`'s return, because the
 * client is welded to `fetch` and this function has no business constructing
 * one: `runFileOperation` builds it from a credential that must not reach this
 * module, exactly as it builds the store.
 */
export interface ProjectionClient {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  runAll(
    statements: readonly { sql: string; params?: unknown[] }[],
    options?: { budget?: unknown; reserve?: number },
  ): Promise<{ applied: number; skipped: boolean }>;
}

/** What one pass learned. No path, no title, no term — see `maintainSearchIndex`. */
export interface ProjectionPass {
  projected: number;
  deleted: number;
  notesIndexed: number;
  notesPending: number;
  /** The projection holds every note the index holds, and the index is current. */
  ready: boolean;
  /** A `D1Error` code, or `null`. Ours, from a closed set — never a provider's. */
  failure: string | null;
  /**
   * Did this pass move anything?
   *
   * **The only reason to schedule another**, and the reason it is not
   * `projected + deleted > 0`: a pass that advanced the R2 index and had no
   * budget left to copy from it has made real progress toward a projection the
   * next link can finish. `committed` rather than `changed`, for the reason
   * `maintainSearchIndex` gives — a pass whose manifest write lost a race did
   * work the winner is about to re-derive, and counting it would have every
   * one of a burst chain twelve deep over the same notes.
   */
  moved: boolean;
  /**
   * Is there anything worth telling the control plane?
   *
   * False on a failure as well as on an idle pass, because the counters are
   * only computed when something moved: reporting the zeros a failed pass
   * carries would write "no notes found" onto the row. A failure is recorded
   * by its own path, with a code and a sentence.
   */
  report: boolean;
}

/**
 * Copy this context's notes into its own search database, a bounded piece at a
 * time. Nobody is waiting on this either.
 *
 * **The half of the projection that does not need anybody present.** The
 * gateway owns the other half and had to: it is the only component that reads
 * note content on a request, and there is deliberately no route by which this
 * control plane could tell it to go and fill a workspace nobody is connecting
 * to — that call shape is exactly what the two-proof binding refuses, and
 * refusing it is what makes bulk extraction impossible by construction. So
 * every trigger was a search, and a context whose owner flipped the switch and
 * closed the app copied nothing, ever. That was the whole gap.
 *
 * What runs here is the gateway's own `projectPass`, imported, over the store
 * `runFileOperation` already opens — the same arrangement `searchNotes` and
 * `maintainSearchIndex` have with `searchIndexedNotes` and `syncShardedIndex`.
 * Three consequences are load-bearing:
 *
 *  - **The R2 index pass comes first, and its diff is what feeds the copy.**
 *    The projection's census is the index's own docmap, so a bucket no search
 *    has ever built an index over has nothing to walk. Running the sync here
 *    means a context that has never been searched still fills — which is the
 *    case the three contexts stuck at "Preparing" were in — and it means the
 *    notes that just moved are copied first, from the diff that pass already
 *    computed. No second listing and no second answer to "what changed".
 *  - **The tier a note is copied at is this runtime's `effectiveVisibility`**,
 *    injected as `visibilityOf` exactly as `isVisible` is injected into
 *    `searchIndexedNotes`, and proven identical to the gateway's by
 *    `__tests__/privacyEngine.test.ts`. A visibility neither recognises is
 *    skipped rather than guessed: the safe guess and the useful guess differ,
 *    and the useful one publishes a private note's vocabulary into the corpus
 *    every member of the context is scored against.
 *  - **Every provider failure is caught and returned, never thrown.** The
 *    caller is a scheduled job whose entire purpose is to record the outcome.
 *    A throw leaves the row saying `backfilling` with nothing to explain it,
 *    which is the bug this exists to close rather than a way to report it.
 *
 * Like `maintainSearchIndex`, it reads every note in the bucket, private ones
 * included, and answers nothing about them: counts only.
 */
export async function projectSearchIndex(
  store: FileStore,
  client: ProjectionClient,
  options: { budget?: number; noteCap?: number } = {},
): Promise<ProjectionPass> {
  const budget = createSearchBudget(options.budget ?? PROJECTION_PASS_BUDGET);
  const reserve = Math.floor(budget.remaining / PROJECTION_RESERVE_SHARE);

  /**
   * What this pass reads off the sync, named rather than inferred.
   *
   * `syncShardedIndex` is JSDoc-typed JavaScript with several return shapes,
   * and TypeScript narrows their union to the one that carries the fewest
   * fields — which drops `touched` and `removed`, the two the projection is
   * here for. Declaring what is read keeps the cast to one place and makes a
   * field that disappears upstream a compile error here rather than an
   * `undefined` the copy quietly walks past.
   */
  interface SyncedPass {
    manifest: Parameters<typeof censusFromManifest>[0] | null;
    pending: number;
    listingTruncated: boolean;
    committed: boolean;
    touched: string[];
    removed: string[];
  }

  let synced: SyncedPass | null = null;
  try {
    synced = (await runIndexPass(store, budget, reserve)) as unknown as SyncedPass;
  } catch {
    // A listing that failed after nothing was promised to anybody changes
    // nothing here: the projection still gets its turn below, because a failed
    // listing is not a reason to stop copying the notes that are already
    // indexed. The next link re-diffs from the manifest.
  }

  let census: Map<string, string> | null = null;
  let indexPending = 0;
  if (synced?.manifest) {
    census = censusFromManifest(synced.manifest);
    indexPending = (synced.pending || 0) + (synced.listingTruncated ? 1 : 0);
  } else {
    // No manifest from this pass — the sync threw, or had no budget to read
    // one. Two object reads rather than a second listing, which is what
    // `loadCensus` is for.
    const loaded = await loadCensus(
      store as unknown as Parameters<typeof loadCensus>[0],
      budget,
    );
    if (loaded) {
      census = loaded.census;
      const freshness = loaded.manifest.freshness;
      indexPending = (freshness.pending || 0) + (freshness.truncated ? 1 : 0);
    }
  }

  const moved = Boolean(synced?.committed);
  if (census === null) {
    // Nothing to walk. Not a failure — a bucket whose index this pass has just
    // started building is the ordinary first link of a cold chain, and `moved`
    // says whether it got anywhere.
    return {
      projected: 0,
      deleted: 0,
      notesIndexed: 0,
      notesPending: 0,
      ready: false,
      failure: null,
      moved,
      report: false,
    };
  }

  const state = await loadPrivacyState(store);
  // Cast because `projectPass` is JSDoc-typed JavaScript whose optional
  // parameters read as required from TypeScript — `reportProgress` defaults to
  // `null` in the body and is deliberately not passed. The fields below are
  // checked against their own declared types; only the omission is waived.
  const result = await projectPass(store, client, {
    census,
    touched: synced?.touched ?? [],
    removed: synced?.removed ?? [],
    visibilityOf: (path: string) =>
      effectiveVisibility(path, state.rules, state.overrides),
    budget,
    noteCap: options.noteCap ?? PROJECTION_NOTE_CAP,
    // A projection cannot honestly call itself complete over a census the R2
    // index is still building — every count here is a floor when a walk was
    // cut short, in the census's own language.
    indexPending,
    // The pass may spend down to nothing: this is not riding a search, and
    // there is no caller after it owed a reserve.
    reserve: 0,
  } as unknown as Parameters<typeof projectPass>[2]);

  const progress = progressFrom(result);
  const failure: string | null = result.failure ?? null;
  return {
    projected: result.projected,
    deleted: result.deleted,
    notesIndexed: progress.notesIndexed,
    notesPending: progress.notesPending,
    ready: progress.state === "ready",
    failure,
    moved: moved || result.projected > 0 || result.deleted > 0,
    report: failure === null && worthReporting(result),
  };
}
