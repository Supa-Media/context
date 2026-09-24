/**
 * Listing one folder at the caller's clearance.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import {
  PRIVACY_KEY,
  type PrivacyRule,
  type Visibility,
  canSee,
  effectiveVisibility,
  foldPath,
  isPlumbing,
  visibilityOf,
} from "../privacy";
import { type Clearance } from "../clearance";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import { requireFolderPath, parentOf, baseName } from "./paths";
import { loadPrivacyState } from "./privacyState";

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
export function folderVisibleAtScope(
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

export function describeFile(
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
