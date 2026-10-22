import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Card } from "../../design/components/Card";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  DELETE_TITLE,
  KEEP_LINE,
  KEEP_TITLE,
  KEPT_EITHER_WAY,
  deleteLine,
  oldCopiesFrom,
  oldCopiesRowLine,
  oldCopiesTitle,
  type OldCopiesSummary,
} from "./oldCopiesWords";

/**
 * The Old copies row in Mail and calendar, and the page it opens (board b1 of
 * `remove-copies`, Dev2 2026-10-21): one row while the copies Context made of
 * mail, calendar and chat are waiting on the owner's answer, gone once they
 * are kept hidden or deleted. Hidden is the default and nothing happens unless
 * the owner chooses. Delete is red text pressed twice, with the count: a
 * one-way step is bold red, inline, never a tinted box.
 */
export function OldCopiesRow({ summary, onOpen }: { summary: OldCopiesSummary; onOpen: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID="old-copies">
      <Text variant="eyebrow" style={styles.rowHead}>
        Old copies
      </Text>
      <Pressable accessibilityRole="button" onPress={onOpen} testID="old-copies-open">
        <Card>
          <View style={styles.line}>
            <View style={styles.grow}>
              <Text variant="rowTitle">{oldCopiesTitle(summary)}</Text>
              <Text variant="rowSub" style={styles.sub}>
                {oldCopiesRowLine(summary)}
              </Text>
            </View>
            <Icon name="chevronRight" size={14} />
          </View>
        </Card>
      </Pressable>
    </View>
  );
}

export function OldCopiesPage({
  summary,
  onBack,
  onKeep,
  onDelete,
}: {
  summary: OldCopiesSummary;
  onBack: () => void;
  onKeep: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = summary.state === "hidden";

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError((failure as { data?: { message?: string } })?.data?.message ?? "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View testID="old-copies-page">
      <View style={styles.crumbs}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to Mail and calendar" onPress={onBack} testID="old-copies-back">
          <Text variant="mini" style={styles.crumbLink}>
            Mail and calendar
          </Text>
        </Pressable>
        <Text variant="mini" style={styles.crumbSep} aria-hidden>
          /
        </Text>
        <Text variant="mini" style={styles.crumbHere}>
          Old copies
        </Text>
      </View>

      <Card>
        <Text variant="rowTitle">{oldCopiesTitle(summary)}</Text>
        <Text variant="rowSub" style={styles.sub}>
          {oldCopiesFrom(summary)}
        </Text>
      </Card>

      <Text variant="eyebrow" style={styles.head}>
        Choose
      </Text>
      <Card>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: !armed }}
          disabled={busy}
          onPress={() => (armed ? setArmed(false) : void act(onKeep))}
          style={styles.line}
          testID="old-copies-keep"
        >
          <View style={styles.grow}>
            <Text variant="rowTitle">{KEEP_TITLE}</Text>
            <Text variant="rowSub" style={styles.sub}>
              {KEEP_LINE}
            </Text>
          </View>
          {armed ? null : <Icon name="check" size={14} color={colors.accent} />}
        </Pressable>
        <View style={styles.divider} />
        <Pressable
          accessibilityRole="button"
          disabled={busy || !settled}
          onPress={() => (armed ? void act(onDelete) : setArmed(true))}
          style={styles.line}
          testID={armed ? "old-copies-delete-confirm" : "old-copies-delete"}
        >
          <View style={styles.grow}>
            <Text variant="rowTitle" style={styles.danger}>
              {busy && armed ? "Deleting…" : DELETE_TITLE}
            </Text>
            <Text variant="rowSub" style={[styles.sub, armed && styles.dangerLine]}>
              {deleteLine(summary, armed)}
            </Text>
          </View>
        </Pressable>
      </Card>
      {error === null ? null : (
        <Text variant="error" style={styles.foot}>
          {error}
        </Text>
      )}
      <Text variant="rowSub" style={styles.foot}>
        {KEPT_EITHER_WAY}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginTop: space.x5, marginBottom: space.x2 },
    rowHead: { marginTop: space.x2, marginBottom: space.x2 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    grow: { flex: 1, minWidth: 0 },
    sub: { marginTop: 2 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.x3 },
    danger: { color: colors.critText, fontWeight: "700" },
    dangerLine: { color: colors.critText, fontWeight: "700" },
    foot: { marginTop: space.x2 },
    crumbs: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: space.x5, marginBottom: space.x3 },
    crumbLink: { color: colors.accent },
    crumbSep: { color: colors.muted },
    crumbHere: { color: colors.text },
  });
