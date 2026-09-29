/**
 * One property of one note, changed from a list: read the note, change that
 * frontmatter line with `setNoteProperty`, write it back against the version
 * read. The write merges into anybody editing the note at the same moment
 * (see `writeNote` and docs/decisions/collaboration.md), and a note that moved
 * on between the read and the write is read again once, since a property set
 * is the same change on either version.
 *
 * Every refusal comes back as a sentence for the menu, never as a throw.
 *
 * With `create`, a note that is not there is written new — the frontmatter
 * and nothing else — by the ordinary create: no version, which the server
 * refuses if a note appeared at that path meanwhile, and that refusal is a
 * conflict like any other, so the note that appeared is read and changed
 * rather than replaced. A folder page uses it to give a folder its first
 * property (`folderPage/`); a list only ever edits notes it has listed.
 *
 * `visibility` is refused before anything is read, whoever asks, and so is a
 * website page's `folder:`, which publishes that folder on the site (see
 * `writable.ts` for both). This is the one road every list and folder page
 * write takes, so the refusal lives here and not only in the surfaces — a
 * surface that offers a key this refuses is a menu that cannot work, and a
 * surface nobody taught is a key written without one.
 */

import { setNoteProperty } from "../../../../../mcp/src/lists.js";
import { toFileError } from "../browser/errors";
import { isWritableProperty, whyNotWritable } from "./writable";

export interface NoteReadWrite {
  read(path: string): Promise<{ text: string; etag: string; encrypted?: boolean; readOnly?: boolean }>;
  /** `expectedEtag` undefined is a create, refused if the note exists. */
  write(path: string, text: string, expectedEtag: string | undefined): Promise<unknown>;
}

const ATTEMPTS = 2;

/** A frontmatter value a list or folder page writes: text, a list of words, or null to clear. */
export type PropertyWriteValue = string | readonly string[] | null;

export async function writeNoteProperty(
  io: NoteReadWrite,
  path: string,
  key: string,
  value: PropertyWriteValue,
  options: { create?: boolean } = {},
): Promise<string | null> {
  return writeNoteProperties(io, path, [[key, value]], options);
}

/**
 * Several properties of one note in one write — a folder's status list is
 * three keys, and three writes could land two of them. Each is changed with
 * `setNoteProperty` in turn on the same text, so every refusal and the
 * read-back check still apply, and any refusal writes nothing.
 */
export async function writeNoteProperties(
  io: NoteReadWrite,
  path: string,
  changes: readonly (readonly [string, PropertyWriteValue])[],
  options: { create?: boolean } = {},
): Promise<string | null> {
  const refused = changes.find(([key]) => !isWritableProperty(key, path));
  if (refused !== undefined) return whyNotWritable(refused[0], path);
  return rewriteNote(
    io,
    path,
    (text) => {
      for (const [key, value] of changes) {
        const changed = setNoteProperty(text, key, value) as { text: string } | { error: string };
        if ("error" in changed) return changed;
        text = changed.text;
      }
      return { text };
    },
    options,
  );
}

/**
 * The road under every list and folder page write: read the note, apply
 * `change` to its text, write it back against the version read, and read
 * again once if it moved on meanwhile — `change` is the same edit on either
 * version. A folder page's lede (`folderPage/lede.ts`) takes it too.
 */
export async function rewriteNote(
  io: NoteReadWrite,
  path: string,
  change: (text: string) => { text: string } | { error: string },
  options: { create?: boolean } = {},
): Promise<string | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let note: { text: string; etag: string | undefined; encrypted?: boolean; readOnly?: boolean };
    try {
      note = await io.read(path);
    } catch (error) {
      if (options.create !== true || toFileError(error).code !== "FILE_NOT_FOUND") return "That note could not be opened.";
      note = { text: "", etag: undefined };
    }
    if (note.encrypted === true) return "That note is encrypted, so it can only be changed from inside it.";
    if (note.readOnly === true) return "You can read that note but not change it.";
    const changed = change(note.text);
    if ("error" in changed) return `That can’t be saved: ${changed.error}.`;
    const text = changed.text;
    if (text === note.text) return null;
    try {
      await io.write(path, text, note.etag);
      return null;
    } catch (error) {
      const { code } = toFileError(error);
      if (code === "CONFLICT" && attempt < ATTEMPTS) continue;
      if (code === "CONFLICT") return "That note is changing right now. Try again in a moment.";
      if (code === "NOTE_ENCRYPTED") return "That note is encrypted, so it can only be changed from inside it.";
      return "That change could not be saved.";
    }
  }
  return "That change could not be saved.";
}
