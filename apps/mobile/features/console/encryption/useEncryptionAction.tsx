import { useState, type ReactNode } from "react";
import type { ShareMoreAction } from "../files/shareDialog/props";
import { LockNoteDialog } from "./LockNoteDialog";

/**
 * "Encrypt with a password…" — the item in a note's share dialog menu that
 * turns this feature on.
 *
 * Deliberately the *only* thing offered for a note that is not already
 * locked, and deliberately silent about the at-rest mode (`set_encryption`,
 * over MCP) — that toggle belongs to any private-scope AI client per
 * `docs/decisions/encryption.md`'s own table, not to this console, and a
 * second switch here for the same word would blur the line the decision file
 * spends a whole section keeping straight ("Encrypted notes are for humans; no
 * AI client reads one").
 *
 * A note already locked with a passphrase gets a pointer rather than a second
 * set of controls: changing the passphrase and removing it both need to prove
 * the *current* one, which only makes sense once the note is open — see
 * `LockedNoteView`, which is where both live.
 *
 * A hook rather than a section because the share dialog now keeps rare
 * actions in its header's menu, and a menu item cannot own the dialog it
 * opens: the menu closes when the item is pressed. So the open state lives
 * here, and the lock dialog is handed back as `overlay` for the share dialog
 * to draw inside its own modal.
 */
export function useEncryptionAction({
  enabled,
  path,
  encrypted,
  onLock,
  busy = false,
  error,
}: {
  /** `false` where nothing should be offered, e.g. a note not open in the editor. */
  enabled: boolean;
  path: string;
  /** Stored encrypted right now, by any recipient — Phase 1 or a passphrase. */
  encrypted: boolean;
  onLock: (passphrase: string) => void;
  busy?: boolean;
  error?: string;
}): { action: ShareMoreAction; overlay?: ReactNode } | undefined {
  const [open, setOpen] = useState(false);
  if (!enabled) return undefined;

  if (encrypted) {
    return {
      action: {
        id: "encrypted",
        label: "Encrypted with a password",
        detail: "Open the note to unlock it, change the password, or remove it.",
        icon: "lock",
        disabled: true,
        testID: "share-lock-note",
        onPress: () => {},
      },
    };
  }

  return {
    action: {
      id: "encrypt",
      label: "Encrypt with a password…",
      detail: "Only people you tell the password can read it. Not Context, and not your AI tools.",
      icon: "lock",
      testID: "share-lock-note",
      onPress: () => setOpen(true),
    },
    overlay: open ? (
      <LockNoteDialog
        path={path}
        busy={busy}
        error={error}
        onLock={(passphrase) => onLock(passphrase)}
        onClose={() => setOpen(false)}
      />
    ) : undefined,
  };
}
