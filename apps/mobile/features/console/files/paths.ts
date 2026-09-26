/**
 * Path arithmetic for the file editor.
 *
 * Small, pure, and separated out because these are the parts that are easy to
 * get subtly wrong and impossible to notice by clicking around: what "…/foo.md"
 * renames to, which name a duplicate takes, whether a drag onto a folder is
 * legal. The console's Jest suite runs in plain node with no renderer (see
 * `jest.config.js`), so anything worth pinning has to live in a module like
 * this rather than inside a component.
 *
 * The backend validates all of this again — `functions/lib/fileOps.ts` refuses
 * a bad path whatever the client sent. This layer exists so a person finds out
 * before they wait for a round trip, not instead of the check that matters.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";

/** The folder a path sits in. `""` is the root. */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** The last segment. */
export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** Every ancestor of a path, root first. Used to auto-expand to a selection. */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

export function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

/**
 * The digits a name carries so that something will sort it — `1-`, `04-`.
 *
 * PARA only works in order: `1-projects` has to come before `2-areas`, and a
 * bucket listing, Obsidian's sidebar, the Files app and `ls` all sort one way,
 * alphabetically. So the order has to be *in the name*, and every tool that
 * reads the bucket then draws the number back at you on every row, in the one
 * product whose whole claim is that the files stay pleasant to live in.
 *
 * The number is filing, the way `.md` is filing. It is kept on disk, where it
 * does its job, and dropped from the label — which is also why this is
 * backwards compatible in both directions: an existing bucket needs no
 * migration to look better, and a context whose folders are drawn without
 * numbers is still, byte for byte, a context any other tool opens in order.
 *
 * ## What counts as one
 *
 * One or two digits, a hyphen, and something left over that does not start
 * with another digit. Each clause is load-bearing, and each one exists to
 * refuse a name rather than to accept one:
 *
 *  - **One or two digits**, so `2026-09-18.md` — a daily note, which is how a
 *    great many people name a great many notes — keeps its year. Four digits
 *    is a date; one or two is somebody counting folders.
 *  - **Nothing left over, nothing stripped.** `1-` is a name, not a prefix
 *    with a name after it, and a row with no text on it is worse than a row
 *    with a number on it.
 *  - **Not another digit**, so `12-25-christmas.md` is left alone rather than
 *    drawn as `25-christmas`, which reads as a bug. A second number after the
 *    hyphen means the first one is probably a month, not an ordinal.
 *  - **Not a dot**, because `1-.hidden` would be drawn as a name this product
 *    reserves (see `describeNameProblem`) for a file it is not.
 *
 * The bias in all four is the same and it is deliberate: **when in doubt, draw
 * what is on disk.** Showing a number nobody wanted is untidy; hiding half of
 * a date is a lie about the customer's own file.
 *
 * Only a hyphen separates. `1 projects`, `1.projects` and `1_projects` are
 * names, not prefixes — a rule that guesses at every punctuation mark somebody
 * might have typed is a rule that eventually eats a name somebody meant.
 *
 * All four clauses are narrower than `titleFromPath`'s
 * `/^\d+[-_.\s]+/` in `functions/lib/shareTitle.ts`, which has dropped the same
 * prefix since share cards existed — deliberately, because the two are doing
 * different jobs. That one *invents a title* and is allowed to refuse ("a card
 * with no title is honest"); this one *draws the customer's own file back at
 * them*, beside the Rename that spells it out, so being wrong is not a missing
 * card but a row naming a file that is not the one on disk.
 *
 * ## What it deliberately does not do
 *
 * **It does not look at the siblings.** `1-plan` and `2-plan` in one folder
 * both draw as `plan`, and that is the accepted cost of a rule a single name
 * can be evaluated against — the alternative is a label that depends on what
 * else happens to be loaded, so the same folder reads differently in the tree,
 * the tab strip and the breadcrumb. Two folders deliberately given the same
 * word are a naming problem the person can see and fix; Rename, Move and the
 * palette all still spell the number out.
 */
const SORT_PREFIX = /^\d{1,2}-(?![\d.])(?=.)/;

/**
 * `1-projects` → `projects`. **Display only** — see `SORT_PREFIX` above, and
 * the warning on `displayName`, which this half is subject to just as much.
 *
 * Nothing but a prefix is ever removed, which is the property worth holding it
 * to from the outside: the result is always a suffix of what went in, and what
 * came off is always a sort number or nothing.
 */
export function withoutSortPrefix(name: string): string {
  return name.replace(SORT_PREFIX, "");
}

/**
 * A whole path, with every segment's sort number dropped —
 * `1-projects/2-planning` → `projects/planning`.
 *
 * For the lines that name a *place* to a reader rather than to the bucket: the
 * subtitle under a recents row, the folder in "Moved to …". The same rule
 * `crumbsFor` applies segment by segment, in the one other shape a path gets
 * drawn in.
 *
 * **Not for a picker.** Where somebody is choosing a destination — the move
 * dialog's list, the palette — the real key is the point, and a trimmed one
 * would offer a folder that is not there.
 */
export function displayPath(path: string): string {
  return isolateForDisplay(path.split("/").map(withoutSortPrefix).join("/"));
}

/**
 * A folder's label — the sort number dropped, the extension kept, contained.
 *
 * `withoutSortPrefix` is the trim and this is the *label*, and the difference
 * is the whole reason this function exists. The trim is mid-pipeline: its
 * stated property is that "the result is always a suffix of what went in",
 * `displayName` slices three characters off the end of it, and `tabLabel`
 * compares two of them to decide whether two tabs collide. A container would
 * break all three.
 *
 * So the container goes at the outermost point — the value a renderer is handed
 * — and this is that point for a folder. `displayName` is the same point for a
 * file, and the pair is what the components call instead of trimming a name
 * themselves. **A folder keeps its extension**: a folder called `notes.md` is
 * a folder called `notes.md`.
 */
export function folderLabel(name: string): string {
  return isolateForDisplay(withoutSortPrefix(name));
}

/**
 * What a file is *called*, as against what it is *named*.
 *
 * `README.md` is drawn as `README`, the way Obsidian draws it and the way the
 * person who wrote the note thinks of it. Every note in this product is
 * markdown by construction — `ensureMarkdown` appends the extension and
 * `writeNote` refuses anything else — so `.md` on every row is four characters
 * of noise repeated down the whole tree, and on a phone they are four
 * characters taken from the name when the row ellipsises.
 *
 * `1-projects` is drawn as `projects` for the same reason and by the same
 * argument: the number is there so a listing sorts, not so a person reads it.
 * `SORT_PREFIX` above is where that rule is stated and bounded.
 *
 * **This is display only, and the distinction is load-bearing.** The name on
 * disk never changes: `TreeRow.name` and `TreeRow.path` still carry the real
 * one, every operation addresses the file by `path`, and Rename prefills from
 * `baseName` rather than from this. A stripper that leaked into a write would
 * rename `foo.md` to `foo` in somebody's bucket, and `privacy.md`'s exact-note
 * rules only address `.md` paths — so the note would silently lose its own
 * visibility on the way past. The number is worse still: dropping `1-` from a
 * write renames `1-projects` to `projects`, which moves every note inside it,
 * breaks every `[[1-projects/…]]` link pointing at them, and re-sorts the
 * context — a folder, its subtree and its share links, for a cosmetic rule.
 *
 * Only `.md` is stripped, and only when something is left. An attachment keeps
 * its extension — `.png` on a row is information, because it is the one thing
 * distinguishing it from the note beside it — and a file literally called
 * `.md` keeps its name rather than becoming a blank row.
 */
export function displayName(name: string): string {
  const called = withoutSortPrefix(name);
  if (!isMarkdown(called)) return isolateForDisplay(called);
  const stem = called.slice(0, -3);
  // Contained AFTER the slice, never before it: a container is two characters
  // at the ends of the string, and `slice(0, -3)` would take the closing one
  // off and leave the value open.
  return isolateForDisplay(stem === "" ? called : stem);
}

/**
 * The name of the file that makes a folder exist.
 *
 * Object storage has no folders, only keys with slashes in them, so `createFolder`
 * writes one key to give the prefix something to be. `README.md` is the name
 * because it is the one every other tool that reads the bucket already
 * understands — Obsidian draws it as a note, GitHub renders it, `ls` shows it.
 */
export const FOLDER_PLACEHOLDER = "README.md";

/**
 * Is this the key that exists so its folder does?
 *
 * **The console does not list this file**, and that is the whole of what this
 * predicate decides — see `listedEntries`. The file is real, stays in the
 * bucket, and is exactly what a folder looks like from Obsidian; what it is not
 * is a note somebody wrote, and printing it on the first row of every folder
 * meant the one place with the least to say got the most prominent line.
 *
 * Two boundaries, both deliberate:
 *
 *  - **Never at the root.** The root prefix needs no key to exist, so a
 *    `README.md` beside `index.md` is a file its owner put there — very
 *    probably the readme of a self-hosted bucket — and hiding it would be
 *    hiding content rather than plumbing.
 *  - **Case-insensitively.** We write `README.md`; a person typing in Obsidian
 *    writes `readme.md` about as often, and they mean the same file. Bucket
 *    keys are case-sensitive and nothing here writes one, so a loose match
 *    costs a row that is drawn and never a key that is touched.
 *
 * What it deliberately does **not** do is look at the contents. A folder
 * overview somebody actually wrote is hidden by the same rule, which is the
 * honest cost of a rule a listing can evaluate: a listing carries names, not
 * bodies, and asking the bucket for every README on every expand would be a
 * request per folder to decide a row. Nothing becomes unreachable — search
 * finds it, a `[[link]]` opens it, the tree keeps drawing it while it is the
 * open note, and Obsidian never hid it in the first place. See
 * "A folder's placeholder is not a row" in `docs/decisions/app-and-console.md`.
 */
export function isFolderPlaceholder(path: string): boolean {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return false;
  return path.slice(slash + 1).toLowerCase() === FOLDER_PLACEHOLDER.toLowerCase();
}

/**
 * Is this the workspace's privacy manifest, `privacy.md` at the root?
 *
 * **The console does not list it either**, for the reason it does not list a
 * folder's placeholder: it is a real file that is not a note anybody wrote. It
 * is generated from the visibility settings, read-only here, and everything it
 * says is already drawn on the rows it governs, so a row for it told a person
 * nothing they could act on. It stays in the bucket, stays readable by agents
 * and Obsidian, and the tree still draws it while it is the open note.
 *
 * Root only and folded the way the gateway folds it (`foldPath`), because that
 * is the one key the gateway treats as the manifest. A `privacy.md` in a folder
 * is somebody's note.
 */
export function isPrivacyManifest(path: string): boolean {
  return path.normalize("NFC").toLowerCase() === "privacy.md";
}

/** A real file the console does not list: a folder placeholder or the manifest. */
export function isUnlistedFile(path: string): boolean {
  return isFolderPlaceholder(path) || isPrivacyManifest(path);
}

/**
 * A new note is a `.md` file whether or not the person typed the extension.
 *
 * Not cosmetic: `privacy.md`'s exact-note rules only address `.md` paths, so a
 * note created as `plan` could never be given its own visibility. Better to add
 * two characters than to explain that later.
 */
export function ensureMarkdown(name: string): string {
  const trimmed = name.trim();
  return isMarkdown(trimmed) ? trimmed : `${trimmed}.md`;
}

/**
 * Why this name will not work, or `null`.
 *
 * The messages are written for the person typing, not for a log: they say what
 * to do instead. The dot rule is the one that needs explaining, because
 * `.history/` and `.audit/` are real folders in their bucket that they can see
 * from Obsidian, and "reserved" without saying by whom is infuriating.
 */
export function describeNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give it a name.";
  if (trimmed.includes("/")) return "A name cannot contain a slash. Use Move to change its folder.";
  if (trimmed.startsWith(".")) {
    return "Names starting with a dot are reserved for history and audit files.";
  }
  if (trimmed === "privacy.md") {
    return "privacy.md is generated from your visibility settings and cannot be replaced.";
  }
  // Control characters and the backslash some backends silently fold to "/" —
  // the same set `apps/mcp/src/store/index.js` refuses at the adapter boundary.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) {
    return "That name contains a character a bucket cannot store.";
  }
  if (trimmed.length > 200) return "That name is too long.";
  return null;
}

/**
 * Why this move will not work, or `null`.
 *
 * `taken` is the set of names already in the destination folder — moves never
 * overwrite, so a collision is refused here rather than discovered as a
 * `DESTINATION_EXISTS` after the drag has already animated.
 */
export function describeMoveProblem(
  from: string,
  destinationFolder: string,
  taken: ReadonlySet<string>,
): string | null {
  const name = baseName(from);
  if (destinationFolder === from) return "That is the folder you are moving.";
  if (destinationFolder === `${from}/` || destinationFolder.startsWith(`${from}/`)) {
    return "A folder cannot be moved inside itself.";
  }
  if (parentPath(from) === destinationFolder) return "It is already there.";
  if (taken.has(name)) {
    return `${destinationFolder === "" ? "The root" : destinationFolder} already has something called ${name}.`;
  }
  return null;
}

/** Where a move lands. */
export function moveTargetFor(from: string, destinationFolder: string): string {
  return joinPath(destinationFolder, baseName(from));
}

/**
 * "foo.md" → "foo copy.md" → "foo copy 2.md".
 *
 * Obsidian's convention, mirrored from `functions/lib/fileOps.ts` so the name
 * the console shows before a duplicate is the name the bucket ends up with.
 * (The server picks the real one; this is what the confirmation says it will
 * be, and the two disagreeing would be its own small betrayal.)
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

/** "1.2 KB". Coarse on purpose — this is a glance, not an accounting. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * `4-archive/2026-08-26T09-14-02-113Z/1-projects/foo.md` → `1-projects/foo.md`.
 *
 * What "restore" puts back. The archive keeps the original path inside the
 * timestamped folder precisely so this is a string operation rather than a
 * guess, and returns `null` for anything that is not an archive path so the
 * console can hide the button instead of offering a restore that would land
 * somewhere arbitrary.
 */
export function restoreTargetFor(archivedPath: string): string | null {
  const match = archivedPath.match(/^4-archive\/[^/]+\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * What the permanent-delete dialog says will happen.
 *
 * A string in a pure module, not a paragraph inside a component, because it is
 * a **claim about the backend** and it has already been wrong once. It used to
 * read "there is no copy kept anywhere, and nothing to restore from" while
 * `deletePath` deleted only the live keys — so every note that had ever been
 * edited kept its previous versions in `.history/`, invisible and unreachable
 * but very much still in the customer's bucket. `deletePath` purges them now,
 * and this sentence is what a test can hold it to.
 *
 * Two things it deliberately does not say:
 *
 *  - **Nothing about the whole bucket.** "No copy anywhere" is a claim this
 *    product cannot currently make: a note that was renamed or moved before
 *    being deleted still has a `.history/<old path>.<stamp>.move.md` snapshot
 *    under the path it used to live at, and `deletePath` only sees the path it
 *    is given. The sentence says what is removed *alongside the note*, which
 *    is exactly what happens.
 *  - **It no longer says nothing about the storage provider.** It used to, on
 *    the grounds that versioning, backups and replication are the customer's
 *    own settings and we cannot see them. Both halves are still true, and the
 *    silence stopped being honest the moment we started telling people to turn
 *    versioning ON as their only protection against a bad overwrite. "This
 *    cannot be undone" is then wrong in the one case we recommended: the
 *    noncurrent version outlives the delete, in their bucket, where only they
 *    can remove it. So the sentence names the condition without claiming to
 *    know which side of it they are on — we still cannot see the setting.
 */
export function describeDeleteForever(path: string, isFolder: boolean): string {
  const subject = isFolder
    ? `Every file in ${path} will be removed from your bucket, along with any earlier versions Context kept alongside them.`
    : `${path} will be removed from your bucket, along with any earlier versions Context kept alongside it.`;
  return (
    `${subject} This cannot be undone from here, and nothing is moved to an archive. ` +
    `If you turned on versioning at your storage provider, earlier versions stay there, ` +
    `and only you can remove them.`
  );
}

/**
 * Every note path the console currently knows about.
 *
 * Which is **not** every note in the context, and that is the point of the
 * name: the tree loads folder by folder, so this holds what somebody has
 * expanded plus whatever a link or a search happened to fetch. It is used for
 * exactly one thing — resolving a bare `[[name]]` in the editor — where an
 * incomplete answer costs one link style and never a wrong destination. Every
 * other link style resolves from the path alone and needs none of this.
 *
 * Sorted so the array is stable between renders that learned nothing new: the
 * value crosses the WebView bridge on native, and an unsorted rebuild would
 * repost a few hundred kilobytes every time a folder collapsed.
 */
export function knownNotePaths(
  listings: Readonly<Record<string, { entries: readonly { kind: string; path: string }[] } | undefined>>,
): string[] {
  const paths = new Set<string>();
  for (const listing of Object.values(listings)) {
    if (listing === undefined) continue;
    for (const entry of listing.entries) {
      if (entry.kind === "file" && entry.path.endsWith(".md")) paths.add(entry.path);
    }
  }
  return [...paths].sort();
}

/**
 * Every note path the editor may resolve a link or `[[` completion against —
 * `knownNotePaths` unioned with the search index's own docmap. See "L1" in
 * `docs/decisions/app-and-console.md`.
 *
 * A union rather than "prefer the index" in either direction: `listings` is
 * always current — a note just created in an expanded folder is real *now* —
 * and `indexed` is complete but a disposable derivative that can be behind or
 * entirely absent (`null`) for a bucket nothing has indexed yet. Neither one
 * alone is the honest answer, so both are asked and neither is trusted over
 * the other.
 *
 * Sorted for the same reason `knownNotePaths` is: a stable reference between
 * renders that learned nothing new, since this crosses the WebView bridge on
 * native.
 */
export function mergeLinkPaths(
  listings: Readonly<Record<string, { entries: readonly { kind: string; path: string }[] } | undefined>>,
  indexed: readonly string[] | null,
): string[] {
  return [...new Set([...knownNotePaths(listings), ...(indexed ?? [])])].sort();
}
