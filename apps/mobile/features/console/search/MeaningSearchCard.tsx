import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Card } from "../../design/components/Card";
import { Icon } from "../../design/components/Icon";
import { Hint } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import {
  MEANING_CARD_BLURB,
  MEANING_CARD_TITLE,
  MEANING_OFF_HINT,
  meaningProgress,
  meaningReadOnlyNote,
  meaningStateWord,
  meaningSwitchOn,
  type MeaningSearchStatus,
} from "./meaningSearch";

/**
 * Search by meaning, in a workspace's settings, under fast search.
 *
 * `FastSearchCard`'s control, for its reason: turning on is one press, turning
 * off arms first, because off deletes what took a backfill to build. Only an
 * owner gets the switch (`onSet` is absent otherwise); a member reads the
 * state alone. Its data comes from `useMeaningSearch`.
 */
export function MeaningSearchCardView({
  status,
  demo,
  onSet,
}: {
  status: MeaningSearchStatus | undefined;
  demo: boolean;
  onSet: ((on: boolean) => Promise<void>) | undefined;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (on: boolean) => {
    if (onSet === undefined) return;
    setWorking(true);
    setFailure(null);
    void onSet(on)
      .catch(() => setFailure("That did not go through. Check your connection and try again."))
      .finally(() => setWorking(false));
  };
  const off = useArming(() => run(false));

  if (status === undefined) {
    return (
      <Card>
        <View style={styles.head}>
          <ActivityIndicator color={colors.text2} size="small" />
          <Text variant="rowSub">Loading…</Text>
        </View>
      </Card>
    );
  }

  const on = meaningSwitchOn(status.state);
  const armed = off.stage === "armed";
  const canPress = status.canChange && !demo && onSet !== undefined;
  const word = working
    ? on
      ? "Turning off…"
      : "Turning on…"
    : armed
      ? "Press again to turn off"
      : meaningStateWord(status.state);
  const progress = meaningProgress(status);

  return (
    <Card testID="meaning-search-card">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle">{MEANING_CARD_TITLE}</Text>
          <Text variant="rowSub" style={styles.blurb}>
            {MEANING_CARD_BLURB}
          </Text>
        </View>
        {canPress ? (
          <Pressable
            role="checkbox"
            aria-checked={on}
            accessibilityLabel={on ? "Turn search by meaning off" : "Turn search by meaning on"}
            disabled={working}
            onPress={on ? off.press : () => run(true)}
            style={styles.toggle}
            testID={on ? "meaning-search-disable" : "meaning-search-enable"}
          >
            <View style={[styles.box, on ? styles.boxOn : null, armed ? styles.boxArmed : null]}>
              {on ? <Icon name="check" size={12} color={colors.surface} /> : null}
            </View>
            <Text variant="rowSub" style={armed ? styles.armedText : null}>
              {word}
            </Text>
            {working ? <ActivityIndicator color={colors.text2} size="small" /> : null}
          </Pressable>
        ) : (
          <Text variant="rowSub" style={styles.stateWord} testID="meaning-search-state">
            {word}
          </Text>
        )}
      </View>

      {progress === null ? null : (
        <Notice style={styles.notice} testID="meaning-search-progress">
          <Text variant="rowSub" role="status">
            {progress}
          </Text>
        </Notice>
      )}

      {status.state === "failed" && canPress ? (
        <Text variant="foot" style={styles.note}>
          It will try again on its own. Searching by your words works as usual meanwhile.
        </Text>
      ) : null}

      {failure === null ? null : <FormError headline={failure} style={styles.notice} />}

      {armed ? (
        <Hint>
          <Text variant="hint">{MEANING_OFF_HINT}</Text>
        </Hint>
      ) : null}

      {canPress ? null : (
        <Text variant="foot" style={styles.note}>
          {meaningReadOnlyNote(demo)}
        </Text>
      )}
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", gap: 12 },
    headText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    blurb: { marginTop: 4, maxWidth: 546 },
    toggle: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
    box: {
      width: 18,
      height: 18,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    boxOn: { borderColor: colors.accent, backgroundColor: colors.accent },
    boxArmed: { borderColor: colors.critText, backgroundColor: colors.critText },
    armedText: { color: colors.critText },
    stateWord: { flexShrink: 0 },
    notice: { marginTop: 15 },
    note: { marginTop: 12, lineHeight: leading(12.5, 1.6) },
  });
