import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { useCopy } from "../../design/useCopy";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * A-09 — Bootstrap from an AI you already talk to.
 *
 * Paste this prompt into the connected client and let it seed the context with
 * what it already knows about the person. Written so somebody who has never
 * used Context can hand it over and get a first pass back without having to
 * type any of their life themselves.
 *
 * The prompt is locked here rather than a locale string because the folder
 * conventions and the guardrails ("check with me before you write") are
 * product claims, not phrasing.
 */
export const BOOTSTRAP_PROMPT =
  "Using everything you know about me, write notes and structure folders in the Context MCP so that the projects, areas, resources etc persist across all of my AI apps. Be sure to follow the conventions of Context — call `orient` first, tell me which folder each note is going in, wait for my go before writing, keep notes short and factual, and never touch index.md or privacy.md.";

export function BootstrapStep({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { label, copy } = useCopy(BOOTSTRAP_PROMPT);

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        You just gave one of your AI clients access to Context. It has no idea
        who you are yet — but the client you pasted this into does. Ask it to
        pass what it knows across.
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        The bootstrap prompt
      </Text>
      <View style={styles.block}>
        <Text variant="code" style={styles.body} selectable>
          {BOOTSTRAP_PROMPT}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          label={label === "Copy" ? "Copy the prompt" : label}
          variant="white"
          onPress={copy}
          testID="welcome-bootstrap-copy"
        />
        <Text variant="foot" style={styles.hint}>
          Paste into Claude or ChatGPT. It will announce each note before
          writing — you approve or steer.
        </Text>
      </View>

      <View style={styles.foot}>
        <Text variant="foot" style={styles.footTitle}>What lands in your context</Text>
        <BulletRow label="Areas" value="a short note about you: who you are and what you're working on now" />
        <BulletRow label="Projects" value="one note per active project: goal, state, decisions open" />
        <BulletRow label="Resources" value="reusable preferences, tools, conventions" />
      </View>

      <View style={styles.pageActions}>
        <Button label="Skip — I'll write my own notes" variant="ghost" onPress={onSkip} />
        <Button label="Continue" variant="white" onPress={onDone} />
      </View>
    </View>
  );
}

function BulletRow({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: {
      marginBottom: space.x5,
      lineHeight: leading(12.5, 1.7),
      color: colors.text2,
    },
    head: { marginTop: space.x2, marginBottom: space.x2 },
    block: {
      backgroundColor: colors.well,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: radii.md,
      padding: space.x4,
    },
    body: { lineHeight: leading(12.5, 1.75), color: colors.text },
    actions: {
      marginTop: space.x4,
      gap: space.x3,
    },
    hint: { color: colors.muted, lineHeight: leading(12.5, 1.6) },
    foot: {
      marginTop: space.x6,
      paddingTop: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    footTitle: {
      fontFamily: fonts.body,
      fontSize: t.label,
      fontWeight: "600",
      color: colors.muted,
      letterSpacing: tracking(11.5, 0.06),
      textTransform: "uppercase",
      marginBottom: space.x3,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x3,
      paddingVertical: space.x2,
    },
    rowLabel: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      fontWeight: "600",
      color: colors.text,
      minWidth: 76,
    },
    rowValue: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      color: colors.text2,
      lineHeight: leading(12.5, 1.6),
      flex: 1,
    },
    pageActions: {
      marginTop: space.x6,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: space.x3,
    },
  });
