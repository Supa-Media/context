import { useState } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { MINIMUM_PASSPHRASE_LENGTH } from "./passphraseOps";

/**
 * The two things somebody does with a passphrase they already have, once a
 * note is already locked: change it, or take it off entirely.
 *
 * Both ask for the **current** passphrase — never the session's key, even for
 * a note this session has unlocked — for the reason `passphraseOps.ts`'s
 * `changePassphrase` and `removePassphrase` both state: somebody who walked
 * away from an unlocked device should not be able to weaken or remove a lock
 * without proving they still know it. A change also asks for the new one
 * twice, for the same reason `LockNoteDialog` does — a typo here is not a
 * typo somebody can reset.
 *
 * One component for both rather than two, because the shape is identical down
 * to the field count; what differs is which fields there are and what the
 * button says.
 */
export function PassphraseActionDialog({
  path,
  mode,
  onConfirm,
  onClose,
  busy = false,
  error,
}: {
  path: string;
  mode: "change" | "remove";
  /** `change`: `(current, next)`. `remove`: `(current)`, `next` unused. */
  onConfirm: (current: string, next: string) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");

  const ready =
    !busy &&
    current.length > 0 &&
    (mode === "remove" ||
      (next.length >= MINIMUM_PASSPHRASE_LENGTH && next === again));

  const title = mode === "change" ? "Change this note's passphrase" : "Remove this note's passphrase";
  const confirmLabel = mode === "change" ? "Change passphrase" : "Remove encryption";

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel={title}>
          <Text variant="paneTitle" role="heading" aria-level={2}>
            {title}
          </Text>
          <Text variant="hint" style={styles.path}>
            {path}
          </Text>

          {mode === "remove" ? (
            <Text variant="hint" style={styles.point}>
              This writes the note back as plain Markdown — readable by your storage
              provider, searchable again, and open to every client connected to this
              context. That is the point of removing it, so it is said here rather than
              only in the button's name.
            </Text>
          ) : null}

          <View style={styles.body}>
            <TextInput
              style={styles.input}
              value={current}
              onChangeText={setCurrent}
              placeholder="Current passphrase"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              accessibilityLabel="Current passphrase"
            />
            {mode === "change" ? (
              <>
                <TextInput
                  style={styles.input}
                  value={next}
                  onChangeText={setNext}
                  placeholder="New passphrase"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  accessibilityLabel="New passphrase"
                />
                <TextInput
                  style={styles.input}
                  value={again}
                  onChangeText={setAgain}
                  placeholder="New passphrase again"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  accessibilityLabel="New passphrase again"
                />
                {next.length > 0 && next.length < MINIMUM_PASSPHRASE_LENGTH ? (
                  <Text variant="hint" style={styles.problem}>
                    {`At least ${MINIMUM_PASSPHRASE_LENGTH} characters.`}
                  </Text>
                ) : null}
                {again.length > 0 && again !== next ? (
                  <Text variant="hint" style={styles.problem}>
                    Those two do not match.
                  </Text>
                ) : null}
              </>
            ) : null}

            {error ? (
              <Text variant="hint" style={styles.problem} testID="passphrase-action-error">
                {error}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <Button label="Cancel" onPress={onClose} />
              <Button
                label={busy ? "Working…" : confirmLabel}
                variant={mode === "remove" ? "danger" : "white"}
                onPress={() => onConfirm(current, next)}
                disabled={!ready}
              />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 480,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 22,
      paddingHorizontal: 24,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    path: { fontFamily: fonts.mono },
    point: { marginTop: 10 },
    body: { marginTop: 14, gap: 10 },
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
    },
    actions: { flexDirection: "row", gap: 10, marginTop: 4, justifyContent: "flex-end" },
  });
}
