import { baseName } from "./paths";
import { namesIn } from "./tree";
import type { FolderListing } from "./types";

/**
 * NOTHING ASKS YOU TO NAME A NOTE BEFORE YOU HAVE WRITTEN IT.
 *
 * ## What this replaced
 *
 * Every route into a new note ran through `NamePrompt`: the explorer's `+`, the
 * row menu's "New note here", ⌘N, the `?quickAction=note` deep link, and the
 * phone's bottom row. All of them put a modal and a text field between somebody
 * and the thing they wanted to write — *"for new note, new drawing etc should
 * not ask you to title it"* — and the field is asking for the one piece of
 * information nobody has yet. A note is named **after** it says something.
 *
 * So the file is created immediately, called `untitled-<date>`, and the title
 * catches up: `titleFor` reads the document's own first heading, and
 * `useFileBrowser` renames the file to match the first time that heading
 * settles into something other than the placeholder. Typing `# Weekly sync` at
 * the top of an untitled note *is* naming it, which is what "the user should be
 * able to title the note while writing in it" asks for.
 *
 * ## Why the date, and why it is the local one
 *
 * `untitled.md`, `untitled 2.md`, `untitled 3.md` is what a chooser-free create
 * produces everywhere else, and it is useless in a bucket somebody reads in
 * Obsidian six months later. A date is the one thing about an untitled note
 * that is always true and always worth knowing, and it is what sorts.
 *
 * It is the **device's** date rather than UTC, because the name is shown to the
 * person who pressed the key, in the folder they are standing in. A note made
 * at 9pm in New York reading `untitled-2026-09-20` would be a note dated
 * tomorrow, on their own screen, in their own bucket.
 *
 * ## The suffix counts collisions, it does not count notes
 *
 * A second untitled note on the same day is `untitled-2026-09-19-2`. The number
 * is chosen against the loaded listing, which is the same authority
 * `createNote`'s own collision check uses — so the name this returns is one
 * that check will accept, and two presses in a row make two notes rather than
 * one note and a refusal. A folder that is not loaded cannot be consulted; the
 * server's conditional create is what refuses a genuine clash, and that path is
 * unchanged.
 */

/** The stem every generated name starts with. Lower case, like the folders. */
export const UNTITLED = "untitled";

/** `2026-09-19`, in the device's own timezone. See the header. */
export function untitledStem(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${UNTITLED}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What a new thing of this kind is called before anybody has named it. */
export type UntitledKind = "note" | "drawing" | "folder";

function suffixFor(kind: UntitledKind): string {
  if (kind === "note") return ".md";
  if (kind === "drawing") return ".excalidraw.md";
  return "";
}

/**
 * A name for a new `kind` in `folder` that nothing loaded is already using.
 *
 * Returns the *whole* name including any extension, so the caller hands it
 * straight to `createNote`/`createFolder` without a second opinion about what
 * a drawing is called.
 */
export function untitledName(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  folder: string,
  kind: UntitledKind,
  now: Date,
): string {
  const stem = untitledStem(now);
  const suffix = suffixFor(kind);
  const taken = namesIn(listings, folder);
  if (!taken.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
  /*
    Bounded rather than a `while (true)`. A thousand untitled notes in one
    folder on one day is not a state worth looping forever over, and the
    fall-through — the millisecond of the clock — is still a name somebody can
    read and still one the server's create will accept.
  */
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${now.getTime()}${suffix}`;
}

/**
 * Whether this name is one of ours and still unclaimed.
 *
 * Deliberately narrow: `untitled-2026-09-19`, optionally `-2`, optionally the
 * drawing's own second extension. A note somebody *called* "untitled thoughts"
 * is their name for it and is never renamed out from under them — which is the
 * whole reason this matches a date rather than the word.
 */
const GENERATED = /^untitled-\d{4}-\d{2}-\d{2}(-\d+)?(\.excalidraw)?(\.md)?$/i;

export function isUntitled(path: string): boolean {
  return GENERATED.test(baseName(path));
}

/**
 * The document's own title — its first ATX heading — or `null`.
 *
 * Only `#`, and only before anything else has been written: a note whose first
 * line is a paragraph has not been titled, and promoting an `##` from halfway
 * down would name the file after a subsection. Frontmatter is skipped, because
 * the console writes it and the person did not.
 *
 * Fenced code is not parsed here and does not need to be: the scan stops at the
 * first non-blank line that is not frontmatter, so a `#` inside a fence can
 * only be reached by a document whose first line opens the fence — and that
 * line is not blank, so the scan has already stopped.
 */
export function titleFor(text: string): string | null {
  const lines = text.split("\n");
  let index = 0;
  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== "---") index += 1;
    index += 1;
  }
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  const line = lines[index];
  if (line === undefined) return null;
  const heading = /^#\s+(.*)$/.exec(line.trim());
  if (heading === null) return null;
  const title = heading[1]!.trim();
  return title === "" ? null : title;
}

