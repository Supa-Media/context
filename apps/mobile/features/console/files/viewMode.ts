/**
 * The mode a note asks to be opened in, declared in its own frontmatter.
 *
 * `readMode.ts` is a *session* mode — "how I am working right now" — and its
 * header states the rule that sends this file into existence: resetting the
 * mode on every selection "makes it a property of the note rather than of how
 * you are working, and then it belongs in the file rather than here". This is
 * that property, in the file, where it was said it would belong.
 *
 * ## Why a note needs one at all
 *
 * A ` ```form ` fence is drawn as a fillable form only while the note is read
 * (`formBlock.ts`, and `docs/decisions/forms.md`'s "the form is drawn when the
 * note is read"). So the one page whose whole purpose is to be *used* rather
 * than written opens as a code fence, and everybody who visits it has to find
 * the eye before they can do the thing they came for. That is the request this
 * answers: the author of the page decides once, and every reader lands on the
 * form.
 *
 * ## What the file may say
 *
 * ```yaml
 * ---
 * view: read      # or: reading, preview
 * ---
 * ```
 *
 * `view: edit` (or `editing`, `source`) is the other direction, and is worth
 * having for a note whose author never wants to land on the rendered view.
 *
 * **`obsidianUIMode: preview | source` is read too**, because these buckets are
 * routinely open in Obsidian at the same time and that is the key Obsidian
 * already honours for exactly this. One line in the file, both apps agree. Ours
 * wins where a note carries both, since it is the one written for this console.
 *
 * A value neither table knows is **ignored**, not guessed at: the note opens
 * however the person was already working, which is what it did before this
 * existed. A key that is only nearly right must not half-work.
 *
 * ## It is a default, and a default is outranked by a person
 *
 * The declaration is applied **once, when the note opens**. Pressing the pencil
 * afterwards wins and keeps winning for as long as that note is open — a form
 * page you cannot edit is not a page, and the one place a broken `form` fence
 * can be fixed is its source. Re-reading the frontmatter on every keystroke
 * would also mean somebody typing `view: read` into their own note being thrown
 * out of the editor mid-word.
 *
 * Nothing here writes. `frontmatter.ts` says why a display-only reader of
 * somebody's YAML never grows a serializer, and this is one more reader.
 *
 * One limit, stated rather than discovered: a note stored encrypted declares
 * nothing this can see, because the console holds its ciphertext and the
 * envelope's plaintext frontmatter is the encryption marker rather than the
 * note's own. Such a note opens in the session's mode.
 */

import { useLayoutEffect, useRef } from "react";

import { properties, splitNote } from "./frontmatter";
import { declareReadMode } from "./readMode";

/** Which of the two ways of looking at a note the file asks for. */
export type ViewMode = "read" | "edit";

/**
 * The words either key accepts, and nothing else.
 *
 * Obsidian's `preview`/`source` sit in the same table as our `read`/`edit`
 * rather than in one of their own: they are the same two answers, and a second
 * table would be a second place for the two vocabularies to drift apart.
 */
const MODES: ReadonlyMap<string, ViewMode> = new Map<string, ViewMode>([
  ["read", "read"],
  ["reading", "read"],
  ["preview", "read"],
  ["edit", "edit"],
  ["editing", "edit"],
  ["source", "edit"],
]);

/** In preference order: ours, then the one Obsidian is already reading. */
const KEYS = ["view", "obsidianuimode"] as const;

/**
 * What this note's frontmatter asks for, or `null` when it asks for nothing.
 *
 * Only the frontmatter is looked at — `splitNote` decides where that ends — so
 * a line reading `view: read` inside the body, in a code fence or in a
 * quotation is prose, the way it looks.
 */
export function declaredView(source: string): ViewMode | null {
  const rows = properties(splitNote(source).frontmatter);
  for (const key of KEYS) {
    for (const row of rows) {
      if (row.key.toLowerCase() !== key) continue;
      const mode = MODES.get(row.value.trim().toLowerCase());
      // A row of this key that says something unreadable is not an answer, so
      // the search carries on — to a later row, and then to the other key.
      if (mode !== undefined) return mode;
    }
  }
  return null;
}

/**
 * Tell the mode bus what the open note asks for, each time a different note
 * opens.
 *
 * `note` is the open note's identity — context and path — and `null` when
 * nothing is open. It is the effect's only dependency **on purpose**: the text
 * is read through a ref so that typing in the note, which changes `source`
 * every keystroke, cannot re-apply a declaration the person has already
 * overruled. See the file header.
 *
 * The declaration is cleared when the note closes, so a page that asked to be
 * read never leaves its answer behind on the next note.
 *
 * `useLayoutEffect` — the only one in this app — because the frame it saves is
 * the one this feature is about. A plain effect runs after the paint, so a form
 * page would be drawn once as the code fence that draws it and then replaced,
 * which is a flicker on exactly the notes somebody set this on to avoid a
 * press. Nothing here renders on a server, so the hook has no second meaning to
 * warn about.
 */
export function useDeclaredView(note: string | null, source: string): void {
  const text = useRef(source);
  text.current = source;
  useLayoutEffect(() => {
    const declared = note === null ? null : declaredView(text.current);
    declareReadMode(declared === null ? null : declared === "read");
  }, [note]);
}
