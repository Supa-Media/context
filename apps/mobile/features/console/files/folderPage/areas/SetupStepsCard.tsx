/**
 * The numbered way to set a bot up, or bring it back, drawn in its Setup section while it isn't working
 * (`setupSteps.ts` says which words). Step 1 is the Copy button itself, which ticks and quietens once pressed; the
 * prompt stays one tap away, in a short scrolling box, for when copying fails. When the bot this panel first saw failing turns green, the steps give way to one line that
 * says so, so the person knows they are done.
 */

import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { writeClipboard } from "../../../../design/clipboard";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { leading, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { SetupSteps } from "./setupSteps";

export function SetupStepsCard({ steps, prompt }: { steps: SetupSteps; prompt: string }) {
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const copy = async () => {
    const ok = await writeClipboard(prompt);
    setCopied(ok);
    if (!ok) setOpen(true);
  };
  return (
    <View style={styles.card} testID="bot-setup-steps">
      <Text variant="tree" style={styles.title}>
        {steps.title}
      </Text>
      <Step n={1} done={copied === true} center>
        <View style={styles.copyRow}>
          <Pressable role="button" onPress={() => void copy()} style={copied === true ? styles.outline : styles.primary} testID="bot-setup-prompt-copy">
            <Text variant="treeMeta" style={copied === true ? styles.outlineWord : styles.primaryWord}>
              {copied === true ? "Copied" : "Copy setup prompt"}
            </Text>
          </Pressable>
          <Pressable role="button" aria-expanded={open} onPress={() => setOpen(!open)} style={styles.link} testID="bot-setup-prompt-toggle">
            <Text variant="treeMeta" style={styles.linkWord}>
              {open ? "Hide the prompt" : "Show the prompt"}
            </Text>
          </Pressable>
        </View>
      </Step>
      {copied === false ? (
        <Text variant="treeMeta" role="alert" style={styles.problem}>
          Couldn't copy. Select the prompt below and copy it.
        </Text>
      ) : null}
      {open ? (
        <ScrollView style={styles.promptBox} nestedScrollEnabled>
          <Text variant="treeMeta" selectable style={styles.promptText} testID="bot-setup-prompt-text">
            {prompt}
          </Text>
        </ScrollView>
      ) : null}
      <Step n={2}>
        <Text variant="treeMeta" style={styles.stepText} testID="bot-setup-step-paste">
          {steps.paste}
        </Text>
      </Step>
      <Step n={3}>
        <Text variant="treeMeta" style={styles.stepText} testID="bot-setup-step-green">
          {steps.green}
        </Text>
      </Step>
    </View>
  );
}

function Step({ n, done = false, center = false, children }: { n: number; done?: boolean; center?: boolean; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const circle = (
    <View style={[styles.number, done && styles.numberDone]}>
      {done ? (
        <Icon name="check" size={10} color={colors.surface} />
      ) : (
        <Text variant="treeMeta" style={styles.numberWord}>
          {n}
        </Text>
      )}
    </View>
  );
  return (
    <View style={[styles.step, center && styles.stepCenter]} testID={`bot-setup-step-${n}`}>
      {/* Beside a line of text, the circle sits in a box one line tall, so it centres on the first line. */}
      <View style={styles.numberLine} aria-hidden>
        {center ? null : (
          <Text variant="treeMeta" style={styles.strut}>
            {"\u200b"}
          </Text>
        )}
        {circle}
      </View>
      <View style={styles.stepBody}>{children}</View>
    </View>
  );
}

/** The bot this panel saw failing is working again: the steps are done. */
export function SetupDone({ words }: { words: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.done} testID="bot-setup-done">
      <Icon name="checkCircle" size={16} color={colors.okText} />
      <Text variant="treeMeta" style={styles.doneWord}>
        {`${words} You're all set.`}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.x3, padding: space.x3, borderRadius: radii.card, borderWidth: 1, borderColor: colors.line },
    title: { color: colors.text, fontWeight: "600" },
    step: { flexDirection: "row", alignItems: "flex-start", gap: space.x2 },
    stepCenter: { alignItems: "center" },
    numberLine: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
    strut: { width: 0 },
    number: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
    numberDone: { borderColor: colors.ok, backgroundColor: colors.ok },
    numberWord: { color: colors.text2, fontWeight: "600", fontSize: pointerType.label, lineHeight: leading(pointerType.label, 1.25) },
    stepBody: { flex: 1, minWidth: 0, gap: space.x1 },
    stepText: { color: colors.text2, flexShrink: 1 },
    copyRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x3 },
    primary: { paddingVertical: 4, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    primaryWord: { color: colors.surface, fontWeight: "600" },
    outline: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    outlineWord: { color: colors.text, fontWeight: "600" },
    promptBox: { maxHeight: 200, borderRadius: radii.sm, backgroundColor: colors.chipFill },
    link: { alignSelf: "flex-start", paddingVertical: 2 },
    linkWord: { color: colors.muted, textDecorationLine: "underline" },
    promptText: { color: colors.text2, padding: space.x2 },
    problem: { color: colors.critText },
    done: { flexDirection: "row", alignItems: "center", gap: space.x2, padding: space.x3, borderRadius: radii.card, borderWidth: 1, borderColor: colors.okBorder, backgroundColor: colors.okWash },
    doneWord: { color: colors.okText, fontWeight: "600", flexShrink: 1 },
  });
