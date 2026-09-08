import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { kdfSupport } from "./kdf";
import { UNSUPPORTED_TITLE } from "./acknowledgement";
import { PassphraseActionDialog } from "./PassphraseActionDialog";
import type { NoteEncryptionController } from "./useNoteEncryption";

/**
 * What a passphrase-locked note actually renders as, in the console.
 *
 * Four states, and only one of them is ever on screen for a given note:
 *
 *  1. **This runtime cannot open locked notes at all** — a phone. Named by
 *     what it is and where to go instead, with no form underneath it at all:
 *     `docs/decisions/encryption.md`'s "Locked notes open on a computer",
 *     never a weaker fallback the person was not told about.
 *  2. **Locked, and this session holds no key for it.** A passphrase prompt.
 *     A wrong passphrase and a corrupted envelope answer with the identical
 *     message — `unlockNote` decides that, once, and this component only
 *     ever prints what it throws.
 *  3. **Locked, and this session already holds the key** — the note was
 *     unlocked earlier and is being revisited. `peek` decrypts the ciphertext
 *     already in hand without asking for the passphrase again, because
 *     nothing here makes a request either way.
 *  4. **Unlocked and open for editing.** A plain buffer, saved by an explicit
 *     press — see `useNoteEncryption.ts`'s own header for why this has no
 *     autosave and no offline queue. Lock, change the passphrase or remove it
 *     entirely are all reachable from here, each behind its own proof.
 *
 * **The plaintext lives only in this component's own state**, reset whenever
 * `path` changes and never handed to anything outside it — not a prop a
 * parent could cache, not a ref that outlives the mount. Closing the note is
 * closing the one place its plaintext existed outside memory the key already
 * occupied.
 */
export function LockedNoteView({
  path,
  stored,
  etag,
  canEdit,
  controller,
  onWritten,
}: {
  path: string;
  /** The note's ciphertext, exactly as read from the bucket. */
  stored: string;
  etag: string | null;
  /** Whether this viewer may write here at all — a locked note some other
   * client shared as `team`-visible may still be read-only to this viewer,
   * and the passphrase is not what decides that; `privacy.md` still does. */
  canEdit: boolean;
  controller: NoteEncryptionController;
  /** Told the new etag after every successful write, so the pane's own state
   * (breadcrumb, "last saved") can catch up. Optional for a caller with
   * nowhere to route it — the note itself stays correct either way. */
  onWritten?: (etag: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const support = kdfSupport();

  const [storedText, setStoredText] = useState(stored);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [currentEtag, setCurrentEtag] = useState(etag);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<"change" | "remove" | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | undefined>(undefined);

  // A different note. Every bit of this component's state is about the one
  // that was open a moment ago, and none of it — least of all the plaintext —
  // may survive into the next note by accident.
  useEffect(() => {
    setStoredText(stored);
    setCurrentEtag(etag);
    setPlaintext(null);
    setDraft("");
    setPassphrase("");
    setError(undefined);
    setDialog(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // The session locked this note out from under this component — pressing
  // "Lock now" here, a manual lock from elsewhere in the console, or the idle
  // sweep. `plaintext` is this component's own copy and the session dropping
  // the key does not clear it by itself; this is what sends the view back to
  // the prompt rather than leaving a plaintext editor open with no key behind
  // it.
  useEffect(() => {
    if (plaintext !== null && !controller.isUnlocked(path)) {
      setPlaintext(null);
      setDraft("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.session, path]);

  // Revisiting a note this session already unlocked: decrypt what is already
  // in hand rather than asking again. No effect (and no request) if the
  // session holds no key for this path — the prompt below covers that.
  useEffect(() => {
    if (!support.supported || plaintext !== null) return;
    if (!controller.isUnlocked(path)) return;
    let cancelled = false;
    controller.peek(path, storedText).then((opened) => {
      if (!cancelled && opened !== null) {
        setPlaintext(opened);
        setDraft(opened);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, storedText, plaintext, support.supported]);

  if (!support.supported) {
    return (
      <View style={styles.notice} testID="locked-note-unsupported">
        <Text variant="paneTitle" role="heading" aria-level={2}>
          {UNSUPPORTED_TITLE}
        </Text>
        <Text variant="hint" style={styles.point}>
          {support.reason}
        </Text>
        <Text variant="hint" style={styles.path}>
          {path}
        </Text>
      </View>
    );
  }

  if (plaintext === null) {
    const submit = () => {
      setBusy(true);
      setError(undefined);
      controller
        .unlock({ path, stored: storedText, passphrase })
        .then(({ plaintext: opened }) => {
          setPlaintext(opened);
          setDraft(opened);
          setPassphrase("");
        })
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : "That did not work.");
        })
        .finally(() => setBusy(false));
    };

    return (
      <View style={styles.notice} testID="locked-note-prompt">
        <Text variant="paneTitle" role="heading" aria-level={2}>
          This note is locked
        </Text>
        <Text variant="hint" style={styles.point}>
          Its content is stored as ciphertext. Enter the passphrase to open it for this
          session — nobody else, including us, can open it without it.
        </Text>
        <Text variant="hint" style={styles.path}>
          {path}
        </Text>
        <TextInput
          style={styles.input}
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder="Passphrase"
          placeholderTextColor={colors.muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          accessibilityLabel="Passphrase"
          onSubmitEditing={submit}
        />
        {error ? (
          <Text variant="hint" style={styles.problem} testID="locked-note-error">
            {error}
          </Text>
        ) : null}
        <Button
          label={busy ? "Unlocking…" : "Unlock"}
          onPress={submit}
          disabled={busy || passphrase.length === 0}
          testID="locked-note-unlock"
        />
      </View>
    );
  }

  const dirty = draft !== plaintext;
  const editable = canEdit;

  const save = () => {
    setBusy(true);
    setError(undefined);
    controller
      .save({ path, plaintext: draft, etag: currentEtag, stored: storedText })
      .then(({ etag: nextEtag, stored: nextStored }) => {
        setPlaintext(draft);
        setStoredText(nextStored);
        setCurrentEtag(nextEtag);
        onWritten?.(nextEtag);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "That did not work.");
      })
      .finally(() => setBusy(false));
  };

  const confirmDialog = (current: string, next: string) => {
    setDialogBusy(true);
    setDialogError(undefined);
    const finished =
      dialog === "change"
        ? controller
            .changePassphrase({
              path,
              stored: storedText,
              etag: currentEtag,
              currentPassphrase: current,
              newPassphrase: next,
            })
            .then(({ etag: nextEtag, stored: nextStored }) => {
              setStoredText(nextStored);
              setCurrentEtag(nextEtag);
              onWritten?.(nextEtag);
            })
        : controller
            .remove({ path, stored: storedText, etag: currentEtag, passphrase: current })
            .then(({ etag: nextEtag, plaintext: revealed }) => {
              // The lock is off: this component's whole reason for existing
              // (a locked note) is gone. `onWritten` tells the pane so it can
              // reopen the note as an ordinary one — `plaintext`/`draft` here
              // are cleared too, so nothing about this render still believes
              // a passphrase governs this path.
              setPlaintext(revealed);
              setStoredText(revealed);
              setCurrentEtag(nextEtag);
              onWritten?.(nextEtag);
            });

    finished
      .then(() => setDialog(null))
      .catch((caught: unknown) => {
        setDialogError(caught instanceof Error ? caught.message : "That did not work.");
      })
      .finally(() => setDialogBusy(false));
  };

  return (
    <View style={styles.editor}>
      <View style={styles.toolbar}>
        <Text variant="hint" testID="locked-note-unlocked-badge">
          Unlocked for this session.
        </Text>
        <View style={styles.toolbarActions}>
          <Button label="Lock now" onPress={() => controller.lock()} testID="locked-note-lock" />
          {editable ? (
            <>
              <Button label="Change passphrase…" onPress={() => setDialog("change")} />
              <Button label="Remove encryption…" variant="danger" onPress={() => setDialog("remove")} />
            </>
          ) : null}
        </View>
      </View>

      <TextInput
        style={styles.body}
        value={draft}
        /*
          Typing is what "idle" is measured against.

          Without the `touch`, the five minutes ran from the unlock (or the
          last save) whatever the person was doing, so an editing session
          longer than the window locked itself mid-sentence — and because
          locking clears this component's `draft` (the effect above, and
          deliberately: a plaintext editor with no key behind it is the state
          this feature must not have) and there is no autosave and no offline
          queue for an unlocked note by design, everything typed since the
          last save went with it, unrecoverably. `controller.touch` renews the
          window *after* sweeping it, so this cannot be used to hold a note
          open past a timeout that has already expired.
        */
        onChangeText={(next) => {
          setDraft(next);
          controller.touch(path);
        }}
        editable={editable}
        multiline
        textAlignVertical="top"
        accessibilityLabel={`${path} unlocked content`}
        testID="locked-note-body"
      />

      {error ? (
        <Text variant="hint" style={styles.problem} testID="locked-note-save-error">
          {error}
        </Text>
      ) : null}

      {editable ? (
        <View style={styles.saveRow}>
          <Button
            label={busy ? "Saving…" : dirty ? "Save" : "Saved"}
            onPress={save}
            disabled={busy || !dirty}
            testID="locked-note-save"
          />
        </View>
      ) : null}

      {dialog !== null ? (
        <PassphraseActionDialog
          path={path}
          mode={dialog}
          onConfirm={confirmDialog}
          onClose={() => {
            setDialog(null);
            setDialogError(undefined);
          }}
          busy={dialogBusy}
          error={dialogError}
        />
      ) : null}
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    notice: {
      padding: space.x4,
      gap: space.x2,
      maxWidth: 520,
    },
    point: { marginTop: 2 },
    path: { fontFamily: fonts.mono },
    problem: { color: colors.warnText },
    input: {
      fontFamily: fonts.mono,
      fontSize: 13,
      color: colors.text,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
      marginTop: 6,
    },
    editor: { flex: 1, minHeight: 0, padding: space.x4, gap: space.x3 },
    toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x2 },
    toolbarActions: { flexDirection: "row", gap: space.x2 },
    body: {
      flex: 1,
      minHeight: 200,
      fontFamily: fonts.mono,
      fontSize: 13,
      color: colors.text,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    saveRow: { flexDirection: "row", justifyContent: "flex-end" },
  });
}
