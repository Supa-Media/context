import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { leading, pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * A-09 — "You're set up.", in the console, the moment the fourth row turns.
 *
 * Drawn over the workspace once, then put away for good on this device
 * (`useSetupWidget`). It is only ever drawn with all four facts true — a
 * summary that could say "set up" over a bucket that never verified was the
 * old closing screen's worst sentence, and `rules.ts` makes it unreachable.
 *
 * The canvas's Download button is a sentence instead: there is no
 * whole-workspace download to wire it to — any folder downloads as a .zip
 * from Files — so the promise is stated with where to act on it rather than as
 * a button that would do less than it says.
 */
export function SetupDone({
  onClose,
  onNewWorkspace,
  onCopyBootstrap,
}: {
  onClose: () => void;
  onNewWorkspace?: () => void;
  onCopyBootstrap: () => Promise<boolean>;
}) {
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState<boolean | null>(null);

  return (
    <View style={styles.card} testID="setup-done" role="dialog" aria-label="You're set up">
      <View style={styles.badge} aria-hidden>
        <Text style={styles.badgeMark}>✓</Text>
      </View>
      <Text role="heading" aria-level={2} style={styles.title}>
        You're set up.
      </Text>
      <Text style={styles.lede}>
        Handle, storage, notes and a tool — all connected. The checklist has done its job and
        won't come back on this device.
      </Text>

      <View style={styles.exit} testID="setup-done-exit">
        <Text style={styles.exitTitle}>Take everything with you</Text>
        <Text style={styles.exitBody}>
          Every note is a plain Markdown file. Any folder downloads as a .zip from Files — free,
          today and after you cancel.
        </Text>
      </View>

      <View style={styles.next}>
        <Text variant="eyebrow" style={styles.nextHead}>
          What's next
        </Text>
        {onNewWorkspace ? (
          <View style={styles.nextRow}>
            <View style={styles.nextText}>
              <Text style={styles.nextTitle}>Add a shared workspace for your team</Text>
              <Text style={styles.nextBody}>
                A separate workspace with its own storage and members.
              </Text>
            </View>
            <Button
              label="Start →"
              variant="dialog"
              onPress={onNewWorkspace}
              testID="setup-done-shared"
            />
          </View>
        ) : null}
        <View style={[styles.nextRow, onNewWorkspace ? styles.nextRule : null]}>
          <View style={styles.nextText}>
            <Text style={styles.nextTitle}>Bootstrap what your AI already knows</Text>
            <Text style={styles.nextBody} role={copied === null ? undefined : "status"}>
              {copied === true
                ? "Copied — paste it into Claude or ChatGPT and watch the folders fill."
                : "Paste one prompt into Claude or ChatGPT — folders and notes appear here."}
            </Text>
          </View>
          <Button
            label="Copy prompt"
            variant="dialog"
            onPress={() => {
              void onCopyBootstrap().then(setCopied);
            }}
            testID="setup-done-bootstrap"
          />
        </View>
      </View>

      <TextLink label="Close" onPress={onClose} style={styles.close} testID="setup-done-close" />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      width: "100%",
      maxWidth: 520,
      paddingTop: 40,
      paddingBottom: 24,
      paddingHorizontal: 40,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: 16,
      backgroundColor: colors.ground,
      alignItems: "center",
      boxShadow: "0 20px 48px rgba(26,23,20,.16)",
    },
    badge: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.hintWash,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 20,
    },
    badgeMark: { fontSize: t.h2, fontWeight: "700", color: colors.accent },
    title: { fontSize: t.h2, fontWeight: "600", color: colors.text, textAlign: "center" },
    lede: {
      marginTop: 10,
      marginBottom: 20,
      fontSize: t.body,
      lineHeight: leading(t.body, 1.55),
      color: colors.text2,
      textAlign: "center",
    },
    exit: {
      alignSelf: "stretch",
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radii.card,
      backgroundColor: colors.hintWash,
      paddingVertical: 14,
      paddingHorizontal: 18,
      gap: 2,
    },
    exitTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    exitBody: { fontSize: t.meta, color: colors.text2, lineHeight: leading(t.meta, 1.5) },
    next: {
      alignSelf: "stretch",
      marginTop: 22,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 18,
      paddingHorizontal: 20,
    },
    nextHead: { color: colors.muted, marginBottom: space.x2 },
    nextRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 10 },
    nextRule: { borderTopWidth: 1, borderTopColor: colors.line },
    nextText: { flex: 1, minWidth: 0 },
    nextTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    nextBody: { marginTop: 2, fontSize: t.meta, color: colors.text2, lineHeight: leading(t.meta, 1.5) },
    close: { marginTop: space.x3 },
  });
