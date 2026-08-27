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
 *  - **Nothing about the storage provider.** Bucket versioning, backups and
 *    replication are the customer's own settings, and we cannot see them.
 */
export function describeDeleteForever(path: string, isFolder: boolean): string {
  const subject = isFolder
    ? `Every file in ${path} will be removed from your bucket, along with the earlier versions Context kept alongside them.`
    : `${path} will be removed from your bucket, along with the earlier versions Context kept alongside it.`;
  return `${subject} This cannot be undone, and nothing is moved to an archive.`;
}
