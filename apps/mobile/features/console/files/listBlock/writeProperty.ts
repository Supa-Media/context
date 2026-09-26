/**
 * One property of one note, changed from a list: read the note, change that
 * frontmatter line with `setNoteProperty`, write it back against the version
 * read. The write merges into anybody editing the note at the same moment
 * (see `writeNote` and docs/decisions/collaboration.md), and a note that moved
 * on between the read and the write is read again once, since a property set
 * is the same change on either version.
 *
 * Every refusal comes back as a sentence for the menu, never as a throw.
 */

import { setNoteProperty } from "../../../../../mcp/src/lists.js";
import { toFileError } from "../browser/errors";

export interface NoteReadWrite {
  read(path: string): Promise<{ text: string; etag: string; encrypted?: boolean; readOnly?: boolean }>;
  write(path: string, text: string, expectedEtag: string): Promise<unknown>;
}

const ATTEMPTS = 2;

export async function writeNoteProperty(
  io: NoteReadWrite,
  path: string,
  key: string,
  value: string | null,
): Promise<string | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let note;
    try {
      note = await io.read(path);
    } catch {
      return "That note could not be opened.";
    }
    if (note.encrypted === true) return "That note is encrypted, so it can only be changed from inside it.";
    if (note.readOnly === true) return "You can read that note but not change it.";
    const changed = setNoteProperty(note.text, key, value);
    if ("error" in changed) return `That can’t be saved: ${changed.error}.`;
    if (changed.text === note.text) return null;
    try {
      await io.write(path, changed.text, note.etag);
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

