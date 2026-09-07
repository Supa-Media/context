import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  ACKNOWLEDGEMENT_CONFIRM,
  ACKNOWLEDGEMENT_PHRASE,
  ACKNOWLEDGEMENT_POINTS,
  ACKNOWLEDGEMENT_TITLE,
  PASSPHRASE_HINT,
  UNSUPPORTED_TITLE,
} from "./acknowledgement";
import { kdfSupport } from "./kdf";
import { MINIMUM_PASSPHRASE_LENGTH } from "./passphraseOps";

/**
 * The screen that takes a decision nobody can take back.
 *
 * Every dialog in this console is a confirmation of something that can be
 * undone by doing the opposite. This one is not, and the shape follows from
 * that rather than from the design system:
 *
 *  - **The consequences are read before the field is reached**, not tucked into
 *    a hint under it. `acknowledgement.ts` holds them, and the test holds this
 *    screen to them.
 *  - **The passphrase is typed twice.** A typo in a password somebody can reset
 *    costs a reset; a typo here costs the note, immediately and silently,
 *    because the note would be locked with a passphrase nobody has ever typed
 *    on purpose.
 *  - **An acknowledgement is typed, not ticked.** The same discipline permanent
 *    deletion already gets in this console: a checkbox is one reflex away from
 *    a note nobody can open.
 *  - **Where the runtime cannot do it, there is no form at all.** Not a
 *    disabled button and not a weaker lock — the reason, and where to go. See
 *    `kdfSupport`.
 *
 * The passphrase leaves this component in exactly one direction: into `onLock`,
 * which the caller wires to `protectNote`, which derives on this device. It is
 * never put in state that outlives the dialog, never defaulted, and never
 * prefilled by anything.
 */
export function LockNoteDialog({
  path,
  onLock,
  onClose,
  busy = false,
  error,
}: {
  path: string;
  onLock: (passphrase: string) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const support = useMemo(() => kdfSupport(), []);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [acknowledged, setAcknowledged] = useState("");

  const tooShort = passphrase.length > 0 && passphrase.length < MINIMUM_PASSPHRASE_LENGTH;
  const mismatched = again.length > 0 && again !== passphrase;
  const ready =
    !busy &&
    passphrase.length >= MINIMUM_PASSPHRASE_LENGTH &&
    again === passphrase &&
    acknowledged.trim().toLowerCase() === ACKNOWLEDGEMENT_PHRASE.toLowerCase();

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable
          style={styles.card}
          onPress={() => {}}
          accessibilityLabel={support.supported ? ACKNOWLEDGEMENT_TITLE : UNSUPPORTED_TITLE}
        >
          <Text variant="paneTitle" role="heading" aria-level={2}>
            {support.supported ? ACKNOWLEDGEMENT_TITLE : UNSUPPORTED_TITLE}
          </Text>
          <Text variant="hint" style={styles.path}>
            {path}
          </Text>

          {!support.supported ? (
            <View style={styles.body}>
              <Text variant="hint">{support.reason}</Text>
              <Button label="Close" onPress={onClose} />
            </View>
          ) : (
            <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
              {ACKNOWLEDGEMENT_POINTS.map((point) => (
                <Text key={point} variant="hint" style={styles.point}>
                  {point}
                </Text>
              ))}

              <TextInput
                style={styles.input}
                value={passphrase}
                onChangeText={setPassphrase}
                placeholder="Passphrase"
                placeholderTextColor={colors.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                // No autofill: a password manager filling this would put the
                // one thing we promise is stored nowhere into a store.
                autoComplete="off"
                textContentType="none"
                accessibilityLabel="Passphrase"
              />
              <Text variant="hint" style={styles.point}>
                {PASSPHRASE_HINT}
              </Text>
              <TextInput
                style={styles.input}
                value={again}
                onChangeText={setAgain}
                placeholder="Passphrase again"
                placeholderTextColor={colors.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                accessibilityLabel="Passphrase again"
              />
              <TextInput
                style={styles.input}
                value={acknowledged}
                onChangeText={setAcknowledged}
                placeholder={`Type "${ACKNOWLEDGEMENT_PHRASE}"`}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={`Type ${ACKNOWLEDGEMENT_PHRASE} to confirm`}
              />

              {tooShort ? (
                <Text variant="hint" style={styles.problem}>
                  {`At least ${MINIMUM_PASSPHRASE_LENGTH} characters.`}
                </Text>
              ) : null}
              {mismatched ? (
                <Text variant="hint" style={styles.problem}>
                  Those two do not match.
                </Text>
              ) : null}
              {error ? (
                <Text variant="hint" style={styles.problem}>
                  {error}
                </Text>
              ) : null}

              <View style={styles.actions}>
                <Button label="Cancel" onPress={onClose} />
                <Button
                  label={busy ? "Locking…" : ACKNOWLEDGEMENT_CONFIRM}
                  onPress={() => onLock(passphrase)}
                  disabled={!ready}
                />
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    // The same shell every other dialog in this console uses, so the one that
    // takes an irreversible decision does not also look like a different app.
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 520,
      maxHeight: "90%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 22,
      paddingHorizontal: 24,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    path: { fontFamily: fonts.mono },
    body: { marginTop: 12, gap: 12 },
    point: { marginBottom: 4 },
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
