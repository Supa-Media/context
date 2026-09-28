/**
 * The console's one editor, lent to a folder page's side peek
 * (`folderPage/panel/peekEditing.ts`): the file browser's note — its draft,
 * autosave, unsaved-changes guard and conflict — and the collaboration room
 * the route opens for whatever that note is (`useNoteRoom`, keyed on
 * `editor.path`), so a note typed in beside a List is in the same room as on
 * its own page. Undefined where the browser has no editor to lend (the landing
 * page's demo); the peek then reads the note, read-only.
 *
 * Memoized on what the peek draws, not on `files` (which changes with every
 * listing), so the panel is not re-rendered by a folder refresh somewhere else.
 */

import { useMemo } from "react";
import type { FileBrowser } from "../../files/browser";
import type { PeekEditing } from "../../files/folderPage/panel/peekEditing";
import type { Presence } from "../../presence/usePresence";

export function usePeekEditing(files: FileBrowser, presence: Presence | undefined): PeekEditing | undefined {
  const { openBeside, closeBeside, canEdit, setDraft, save, loadImage } = files;
  const { path, draft, status, readOnly, encrypted } = files.editor;
  return useMemo(
    () =>
      openBeside === undefined || closeBeside === undefined
        ? undefined
        : {
            open: openBeside,
            close: closeBeside,
            editor: { path, draft, status, readOnly, encrypted },
            canEdit,
            // The room is the editor's: only while it is about the note the editor holds.
            ...(presence === undefined ? {} : { presence }),
            onChange: setDraft,
            onSave: save,
            onLoadImage: loadImage,
          },
    [openBeside, closeBeside, path, draft, status, readOnly, encrypted, canEdit, presence, setDraft, save, loadImage],
  );
}
