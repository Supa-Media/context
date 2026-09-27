/**
 * The notes a query could mean, best first — the ranking behind the `[[`
 * completion (`linkComplete.ts`) and the Link sheet (`LinkSheet.tsx`).
 *
 * On its own, with no imports, because the two callers sit on opposite sides
 * of the web view: the completion runs inside the editor, and the sheet is
 * native React Native, which must not pull CodeMirror in to rank a list
 * (`editorBundle.test.ts`, "the native path never imports the editor"). One
 * ranking, so a note the sheet offers is the note `[[` would have offered for
 * the same letters, and the target it writes is the same rooted path.
 */

/** One offered note. */
export interface NoteChoice {
  /** The note's own name, without the folder or the extension. */
  readonly label: string;
  /** The folder it is in, or `""` at the root. */
  readonly folder: string;
  /** What is written into the document. */
  readonly insert: string;
}

/** `1-projects/foo/overview.md` → `overview`. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** `1-projects/foo/overview.md` → `1-projects/foo`. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * How many offers to build.
 *
 * A cap rather than the whole bucket, because this list is rebuilt on every
 * keystroke inside a `[[` and an empty query offers everything. Fifty is more
 * than fits on a phone screen twice over, and a query that needs more than
 * fifty candidates is a query that has not been typed yet.
 */
export const MAX_CHOICES = 50;

/**
 * The notes that could be meant by `query`, best first.
 *
 * Ranked in three bands rather than scored, because the bands are the thing a
 * person can predict: a name that *starts* with what you typed, then a name
 * that contains it, then a path that contains it. Within a band, alphabetical —
 * a stable order matters more than a cleverer one when the list is being
 * rebuilt under a moving caret.
 *
 * The note being edited is never offered. A link from a note to itself is not
 * something somebody is reaching for at a `[[`, and it is the one candidate
 * guaranteed to rank first in every band.
 */
export function noteChoices(
  query: string,
  paths: readonly string[],
  self: string | null,
): NoteChoice[] {
  const needle = query.trim().toLowerCase();
  const banded: { band: number; path: string }[] = [];

  for (const path of paths) {
    if (path === self) continue;
    const name = baseName(path).toLowerCase();
    const band =
      needle === "" || name.startsWith(needle)
        ? 0
        : name.includes(needle)
          ? 1
          : path.toLowerCase().includes(needle)
            ? 2
            : -1;
    if (band < 0) continue;
    banded.push({ band, path });
  }

  banded.sort((a, b) => (a.band === b.band ? a.path.localeCompare(b.path) : a.band - b.band));
  return banded.slice(0, MAX_CHOICES).map(({ path }) => ({
    label: baseName(path),
    folder: folderOf(path),
    insert: path.replace(/\.md$/, ""),
  }));
}
