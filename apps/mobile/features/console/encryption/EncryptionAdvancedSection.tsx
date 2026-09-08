import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { LockNoteDialog } from "./LockNoteDialog";

/**
 * "Password-encrypt content" — the advanced option under a note's share
 * dialog that turns this feature on.
 *
 * Deliberately the *only* thing this section offers for a note that is not
 * already locked, and deliberately silent about the at-rest mode
 * (`set_encryption`, over MCP) — that toggle belongs to any private-scope AI
 * client per `docs/decisions/encryption.md`'s own table, not to this console,
 * and showing a second switch here for the same word would blur the line the
 * decision file spends a whole section keeping straight ("Encrypted notes are
 * for humans; no AI client reads one").
 *
 * A note already locked with a passphrase gets a pointer rather than a second
 * set of controls: changing the passphrase and removing it both need to prove
 * the *current* one, which only makes sense once the note is open — see
 * `LockedNoteView`, which is where both live.
 */
export function EncryptionAdvancedSection({
  path,
  /** Stored encrypted right now, by any recipient — Phase 1 or a passphrase. */
  encrypted,
  onLock,
  busy = false,
  error,
}: {
  path: string;
  encrypted: boolean;
  onLock: (passphrase: string) => void;
  busy?: boolean;
  error?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  if (encrypted) {
    return (
      <Text variant="hint">
        This note is encrypted. Open it to unlock, change its passphrase, or remove it.
      </Text>
    );
  }

  return (
    <View style={styles.row}>
      <Text variant="hint">
        Lock this note's content behind a passphrase only you — and anyone you tell it to,
        yourself — can read it with. No connected client, and not us, can open it.
      </Text>
      <Button
        label="Password-encrypt content…"
        onPress={() => setOpen(true)}
        testID="share-lock-note"
      />
      {open ? (
        <LockNoteDialog
          path={path}
          busy={busy}
          error={error}
          onLock={(passphrase) => onLock(passphrase)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

function makeStyles(_colors: Colors) {
  return StyleSheet.create({
    row: { gap: space.x2, alignItems: "flex-start" },
  });
}
