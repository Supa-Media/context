import { useState } from "react";
import type { FileBrowser } from "../../files/browser";
import { useNoteEncryption } from "../../encryption/useNoteEncryption";
import { useNoteLockPropagation } from "../../encryption/lockPropagation";
import type { ConsoleData, selectedContext } from "../../types";

/**
 * The note-encryption machinery Browse drives: the controller, the lock
 * announcement, and the state of the one dialog that locks a note. Called
 * from `useFolderListing` at the point these hooks always ran.
 */
export function useBrowseEncryption({
  settled,
  current,
  data,
  files,
}: {
  settled: boolean;
  current: ReturnType<typeof selectedContext>;
  data: ConsoleData;
  files: FileBrowser;
}) {
  /**
   * The passphrase machinery for this context, and nowhere else.
   *
   * One instance per context rather than one per open note: the unlock
   * session (`session.ts`) is deliberately a property of "the room you are
   * in", not of any one file — locking is total, and a note unlocked five
   * minutes ago in a tab that has since moved elsewhere still counts against
   * the idle timeout. `workspaceId` is `null` while the context is settling
   * (`!settled`, above) or has no bucket at all, and every operation this
   * hook exposes refuses cleanly rather than acting against the wrong
   * context's actions.
   */
  const noteEncryption = useNoteEncryption(
    settled ? (current?.id ?? null) : null,
    undefined,
    data.encryptionWriters,
  );
  const announceNoteLock = useNoteLockPropagation(
    settled ? (current?.id ?? null) : null,
    (path) => {
      noteEncryption.close(path);
      files.encryptedElsewhere(path);
    },
  );

  /**
   * The one error the "Password-encrypt content" dialog shows, if the write
   * that locks the note failed. Held here rather than inside
   * `useEncryptionAction` because the operation it reports on
   * (`noteEncryption.protect`) is called from here, against `files.editor`.
   */
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<string | undefined>(undefined);

  return { noteEncryption, announceNoteLock, lockBusy, setLockBusy, lockError, setLockError };
}

/** What `useBrowseEncryption` hands back. */
export type BrowseEncryption = ReturnType<typeof useBrowseEncryption>;
