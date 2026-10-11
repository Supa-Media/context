/**
 * Creating a folder, and choosing a name that is not already taken.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath, baseName, joinPath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { writeFile } from "./writing";
import { type WalkStop, walkStopped } from "./walk";

/* -------------------------------------------------------------------------- */
/*                             creating and copying                           */
/* -------------------------------------------------------------------------- */

/**
 * What lands in a folder the moment it is made: its `about.md`.
 *
 * S3 has no folders — a folder is a shared key prefix — so an "empty folder"
 * can only exist in a UI's memory unless something is written. Rather than
 * invent a hidden marker object (a dot-prefixed key is plumbing and would be
 * invisible to the very tools this is for), a new folder gets one key, and that
 * key is the folder's about note: the description the app shows at the top of
 * the folder page. The folder is then real for Obsidian, rclone, the gateway
 * and everything else that reads the bucket.
 *
 * It is written empty. A `# <name>` heading would become the folder page's
 * title (a front note's heading titles its folder) and would then go stale the
 * first time the folder was renamed; an empty note leaves the title to the
 * folder's own name and the description to the person, or to their agent,
 * which `orient` tells to write it.
 *
 * `renderNewFolderAbout` is exported so the copy is pinned by a test rather than
 * being a string literal nobody would notice changing. `removeNewFolder` relies
 * on this exact text to recognise a folder that is still only this key.
 */
export function renderNewFolderAbout(_folder: string): string {
  return "";
}

/**
 * Create a folder — which means writing the one key that makes its prefix
 * exist. See `renderNewFolderAbout` for what that key holds and why.
 *
 * The result's `readme` field is the path of that key. It keeps its old name
 * because it is part of the mutation result the app already reads; the file is
 * now `about.md`.
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

  const about = joinPath(folder, "about.md");
  const existing = await store.get(about);
  if (existing !== null) {
    throw new FileOpError("DESTINATION_EXISTS", "That folder already exists.");
  }
  await writeFile(store, {
    path: about,
    text: renderNewFolderAbout(folder),
    clearance: options.clearance,
    now: options.now,
  });
  return { path: folder, readme: about };
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
export async function namesInUse(store: FileStore, folder: string): Promise<Set<string>> {
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
