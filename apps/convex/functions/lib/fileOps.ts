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
} from "./privacy";
import { renderPrivacyManifestForFolders, type ScaffoldStore } from "./scaffold";
import { indexByName, rewriteLinks } from "@context/shared/src/links";
// The gateway's search, imported rather than ported — see `searchNotes` below.
// `apps/mcp` targets the Workers runtime, which is Convex's runtime too, so
// these run here unmodified over the same store `provisioning.ts` already
// builds from a binding.
import { createSearchBudget } from "../../../mcp/src/search/maintain.js";
import { syncShardedIndex } from "../../../mcp/src/search/shards.js";
import { searchIndexedNotes } from "../../../mcp/src/search/visible.js";
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
const HISTORY_PREFIX = ".history/";

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
 * took a console search over a real brain from twenty-odd seconds to a
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
 * cold brain converges in a handful of passes rather than dozens.
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
  | "FOLDER_TOO_LARGE"
  /** The store would not hand over the whole listing. Not the folder's fault. */
  | "LISTING_INCOMPLETE"
  | "ARCHIVE_UNAVAILABLE"
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
  // A nested `team` *rule* has to count for the same reason a nested `team`
  // exception does, and only the exceptions were being scanned. An owner who
  // shared `2-areas/shared` out of a private `2-areas` got a folder that read
  // fine by direct path and did not appear in the tree at all — the root
  // listing came back empty and `2-areas` answered not-found — so the thing
  // they had just shared was reachable only by somebody who already knew its
  // name. The disclosure is the same one the loop above already accepts: an
  // ancestor's name, in exchange for the shared folder being reachable.
  for (const rule of rules) {
    if (rule.vis === "team" && rule.prefix.startsWith(`${folderPath}/`)) return true;
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
  options: { path: string; scope: Scope },
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
    !folderVisibleAtScope(folder, options.scope, state.rules, state.overrides);

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
          nearestVisibleAncestor(folder, options.scope, state.rules, state.overrides),
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
  scope: Scope,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): string {
  let at = parentOf(folder);
  while (at !== "" && !folderVisibleAtScope(at, scope, rules, overrides)) {
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

  // The version being replaced is not copied anywhere. Object versioning at the
  // provider is what keeps it, and it is the customer's to enable on a bucket
  // they own — see docs/decisions/storage-and-credentials.md. With it off, this
  // overwrite is final, and the console says so before it runs.
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
  if (!folderVisibleAtScope(folder, options.scope, state.rules, state.overrides)) {
    throw notFound();
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
  scope: Scope,
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
      if (!canSee(object.key, scope, rules, overrides)) {
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
  const prefix = pathIsFolder ? `${HISTORY_PREFIX}${path}/` : `${HISTORY_PREFIX}${path}.`;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
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
          if (!object.key.startsWith(`${HISTORY_PREFIX}${key}.`)) continue;
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
  scope: Scope,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): void {
  for (const destination of destinations) {
    if (scope === "private") continue;
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
  scope: Scope,
  state: PrivacyState,
): void {
  assertDestinationsVisible(
    pairs.map((pair) => pair.destination),
    scope,
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
 * cannot leak.
 */
function oneRulePerPrefix(rules: readonly PrivacyRule[]): PrivacyRule[] {
  const byPrefix = new Map<string, PrivacyRule>();
  for (const rule of rules) {
    const existing = byPrefix.get(rule.prefix);
    if (existing === undefined || (existing.vis === "team" && rule.vis === "private")) {
      byPrefix.set(rule.prefix, rule);
    }
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
  if (!canSee(from, options.scope, state.rules, state.overrides)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);

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
    if (!folderVisibleAtScope(to, options.scope, state.rules, state.overrides)) throw notFound();
    throw new FileOpError(
      "DESTINATION_EXISTS",
      sourceIsFolder
        ? "That folder already exists. Moving one folder onto another would merge them."
        : "A folder already exists at that path.",
    );
  }
  if (sourceIsFolder && (await store.get(to)) !== null) {
    if (!canSee(to, options.scope, state.rules, state.overrides)) throw notFound();
    throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
  }

  const walk = sourceIsFolder
    ? await keysUnder(store, from, options.scope, state.rules, state.overrides)
    : { keys: [from], withheld: [] };
  const sources = walk.keys;
  if (!sourceIsFolder && (await store.get(from)) === null) throw notFound();
  if (sources.length === 0) throw notFound();

  const folderMove = sourceIsFolder ? { from, to } : null;

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  assertMoveDestinationsVisible(pairs, options.scope, state);

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
    if (object === null) continue; // vanished mid-move; nothing to carry
    const body = await object.text();
    await store.put(pair.destination, body);
    await store.delete(pair.source);
  }

  await remapPrivacy(store, {
    moves: pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
    folderMove,
    survivors: walk.withheld,
  });

  const references = await rewriteReferences(store, {
    scope: options.scope,
    state,
    renames: new Map(pairs.map((pair) => [pair.source, pair.destination])),
  });

  return { from, to, paths: pairs.map((pair) => pair.destination), references };
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
 * because a brain whose links rot the first time somebody tidies a folder is a
 * brain people stop tidying. A rename made in the console and the same rename
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
    scope: Scope;
    state: PrivacyState;
    renames: ReadonlyMap<string, string>;
  },
): Promise<ReferenceRewrite> {
  if (options.renames.size === 0) return { notes: 0, links: 0, capped: false };

  let keys: string[] | null;
  try {
    keys = await visibleNoteKeys(store, options.scope, options.state);
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
      No snapshot. Version history is the customer's object versioning — see
      `docs/decisions/storage-and-credentials.md` — and adding one back for this
      path alone would restore the write amplification that decision removed
      from every other one.
    */
    await store.put(key, rewritten.text);
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
  scope: Scope,
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
      if (!canSee(object.key, scope, state.rules, state.overrides)) continue;
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
  options: { from: string; to: string; scope: Scope },
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
  if (!canSee(from, options.scope, state.rules, state.overrides)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  // `copyPrivacy` only ever writes a per-note exception, never a folder rule,
  // so a partial copy has nothing to get wrong and `filtered` is not needed.
  const sources = sourceIsFolder
    ? (await keysUnder(store, from, options.scope, state.rules, state.overrides)).keys
    : [from];
  if (sources.length === 0) throw notFound();

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  assertDestinationsVisible(
    pairs.map((pair) => pair.destination),
    options.scope,
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
  if (!canSee(path, options.scope, state.rules, state.overrides)) throw notFound();

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
  // A free destination, because `movePath` refuses to merge onto an existing
  // folder and archiving a child and then its parent inside the same
  // millisecond lands the second one on top of the first. The stamp is
  // server-generated and never caller-chosen, so disambiguating it discloses
  // nothing and keeps "never merges" true rather than carving an exception into
  // it. Archiving twice in one millisecond is a scripted or concurrent caller,
  // not a person clicking twice.
  const stamp = timestampSlug(options.now);
  let destination = `${ARCHIVE_ROOT}/${stamp}/${path}`;
  for (let attempt = 2; attempt <= 100; attempt += 1) {
    if (!(await isFolder(store, destination)) && (await store.get(destination)) === null) break;
    destination = `${ARCHIVE_ROOT}/${stamp}-${attempt}/${path}`;
  }

  // Archiving is a move, so it inherits the destination rule — and on the
  // scaffold's defaults `4-archive` is private, which means a team caller
  // cannot archive. That is right: archiving a shared note into a private
  // archive takes it away from everybody else, irreversibly for the person who
  // did it. The gateway's `archive_note` has always refused it.
  //
  // What it must not do is inherit the *message*. "That file does not exist"
  // about a note the caller is looking at explains nothing and points at the
  // wrong thing. Naming `4-archive` discloses nothing they do not already
  // hold: whether it is shared is visible in their own root listing.
  const state = await loadPrivacyState(store);
  if (options.scope !== "private" && visibilityOf(destination, state.rules) !== "team") {
    throw new FileOpError(
      "ARCHIVE_UNAVAILABLE",
      "Archiving needs access to 4-archive, which has not been shared with you. Ask the owner to share it, or move this somewhere you can both see.",
    );
  }

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
  const walk = targetIsFolder
    ? await keysUnder(store, path, options.scope, state.rules, state.overrides)
    : { keys: [path], withheld: await namesExtending(store, path) };
  const keys = walk.keys;
  if (!targetIsFolder && (await store.get(path)) === null) throw notFound();
  // A folder holding nothing this caller can see is not a folder they can
  // empty. Answering `notFound()` is byte-identical to a folder that was never
  // there, where reporting "deleted 0 files" would say one is present.
  if (targetIsFolder && keys.length === 0) throw notFound();

  for (const key of keys) await store.delete(key);

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
    targetIsFolder && options.scope === "private" ? null : keys,
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
function writableAsRule(folder: string): boolean {
  try {
    const parsed = parsePrivacyManifest(
      renderPrivacyRulesBlock([{ prefix: folder, vis: "private" }], new Map()),
    );
    return (
      parsed.rules.length === 1 &&
      parsed.rules[0]!.prefix === folder &&
      parsed.overrides.size === 0
    );
  } catch {
    return false;
  }
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
  // Visibility writes rewrite `privacy.md`, the file that decides what every
  // non-owner may see — so only the owner's scope may reach them. The public
  // actions already require `owner`; this refusal is the layer that survives
  // a future caller getting that minimum wrong, the way the console once did.
  if (options.scope !== "private") {
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

  const state = await mutateManifest(store, (current) => {
    if (!canSee(path, options.scope, current.rules, current.overrides)) throw notFound();
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
  options: { path: string; visibility: Visibility; scope: Scope },
): Promise<VisibilityResult> {
  // Visibility writes rewrite `privacy.md`, the file that decides what every
  // non-owner may see — so only the owner's scope may reach them. The public
  // actions already require `owner`; this refusal is the layer that survives
  // a future caller getting that minimum wrong, the way the console once did.
  if (options.scope !== "private") {
    throw new FileOpError(
      "PATH_INVALID",
      "Only the owner of a context can change visibility.",
    );
  }
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
  if (!touchesOverride && !touchesRule) return;

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
    const deduped = oneRulePerPrefix(rules);
    let overrides = current.overrides;
    for (const move of change.moves) {
      overrides = movedOverrides(move.from, move.to, deduped, overrides);
    }
    return { rules: deduped, overrides };
  });
}

/** Give a copy the same exception as its original, where it is still one. */
async function copyPrivacy(
  store: FileStore,
  pairs: { from: string; to: string }[],
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;
  if (!pairs.some(({ from }) => hasOverride(state.overrides, from))) return;

  await mutateManifest(store, (current) => {
    let overrides = current.overrides;
    for (const pair of pairs) {
      const existing = overrideFor(current.overrides, pair.from);
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
export const IMAGE_PREFIX = ".images/";

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
 * `abc`, `abc.txt` and `abc.svg` — measured, returning `{ key: ".images/abc" }`
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
  const object = await store.get(`${IMAGE_PREFIX}${leaf}`);
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
 * console search over a real brain from twenty-odd seconds to a fraction of
 * one. It reads a manifest, the shards this query's terms can be in, and the
 * notes it is quoting. `searchContext` schedules `maintainSearchIndex` behind
 * the answer when the answer says the index is behind.
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
export async function searchNotes(
  store: FileStore,
  options: { query: string; prefix?: string; scope: Scope; budget?: number },
): Promise<SearchResults> {
  const query = options.query.trim();
  if (query === "") {
    return {
      hits: [],
      matchCount: 0,
      matchCountIsFloor: false,
      indexIncomplete: false,
      indexMissing: false,
    };
  }

  const folder = options.prefix ? requireFolderPath(options.prefix) : "";
  const state = await loadPrivacyState(store);
  // A folder this scope cannot open is not a narrower search, it is a folder
  // that does not exist — the same answer `listFolder` gives, so a prefix
  // cannot become a way to ask whether a hidden folder has anything in it.
  if (folder !== "" && !folderVisibleAtScope(folder, options.scope, state.rules, state.overrides)) {
    throw notFound();
  }

  const found = await searchIndexedNotes(store as unknown as SearchStore, {
    isVisible: (path: string) => canSee(path, options.scope, state.rules, state.overrides),
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
    query,
    prefix: folder,
    budget: createSearchBudget(options.budget ?? CONSOLE_SEARCH_BUDGET),
    // A person typed this and is watching a spinner, which is exactly who the
    // rule is for: a miss over an index that believes it is converged buys one
    // listing and asks again, and an answer with hits in it buys nothing. The
    // console is where somebody writes a note and then looks for it, so the
    // case this covers — the index is current as of a minute ago and the note
    // is newer than that — is the console's own most likely miss.
    refreshOnMiss: true,
  });

  if (!found.indexed) {
    return {
      hits: [],
      matchCount: 0,
      matchCountIsFloor: false,
      indexIncomplete: false,
      indexMissing: true,
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
) {
  return await syncShardedIndex(store as unknown as Parameters<typeof syncShardedIndex>[0], {
    budget,
    reserve,
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
  });
}

/**
 * Bring the search index a pass further. Nobody is waiting on this.
 *
 * A console search reads a ready index and maintains nothing, so this is the
 * whole of the console's half of index maintenance — a full listing of the
 * bucket, an etag diff, the notes that changed re-read, the shards they belong
 * to rewritten. It used to happen in front of the person asking the question,
 * which is what made a search over a real brain take twenty seconds and
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
  options: { budget?: number } = {},
): Promise<{ pending: number; changed: boolean; complete: boolean }> {
  const pass = await runIndexPass(store, createSearchBudget(options.budget ?? INDEX_SYNC_BUDGET));
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
