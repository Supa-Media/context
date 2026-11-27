/**
 * The bot panel's Helpers: each session the bot started for deep work, as a sub-agent of it, named "Claude via Grok
 * Bot". Live ones (working, waiting on an answer) are rows; ones that ended fold into one quiet line that opens them,
 * greyed. A press opens the helper's own note: its Progress checklist and its mail with the bot. Drawn only when the
 * bot has had a helper; a bot that never has keeps the panel it has today.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { Face } from "../Glyphs";
import { HelperFace } from "../../../faces/HelperFace";
import { endedLine, isLive, statusWords, type Helper } from "./botHelpers";

export function BotHelpers({ helpers, botFace, now, open }: { helpers: readonly Helper[]; botFace: Face; now: number; open: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [showEnded, setShowEnded] = useState(false);
  if (helpers.length === 0) return null;
  const live = helpers.filter(isLive);
  const ended = helpers.filter((each) => !isLive(each));
  return (
    <View style={styles.section} testID="bot-panel-helpers">
      <Text variant="treeMeta" style={styles.title}>
        Helpers
      </Text>
      {live.length === 0 ? (
        <Text variant="treeMeta" style={styles.muted}>
          None working now.
        </Text>
      ) : null}
      {live.map((helper) => (
        <HelperRow key={helper.path} helper={helper} botFace={botFace} now={now} open={open} />
      ))}
      {ended.length === 0 ? null : (
        <Pressable
          onPress={() => setShowEnded((was) => !was)}
          accessibilityRole="button"
          aria-expanded={showEnded}
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.fold, hovered && styles.hover]}
          testID="bot-panel-helpers-ended"
        >
          <Text variant="treeMeta" style={styles.muted}>
            {endedLine(ended, now)}
          </Text>
          <Icon name={showEnded ? "chevronDown" : "chevronRight"} size={11} color={colors.muted} />
        </Pressable>
      )}
      {showEnded ? ended.map((helper) => <HelperRow key={helper.path} helper={helper} botFace={botFace} now={now} open={open} />) : null}
    </View>
  );
}

function HelperRow({ helper, botFace, now, open }: { helper: Helper; botFace: Face; now: number; open: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const live = isLive(helper);
  const status = statusWords(helper, now);
  const dot = helper.status === "working" ? colors.ok : helper.status === "waiting" ? colors.warn : colors.muted;
  return (
    <Pressable
      onPress={() => open(helper.path)}
      accessibilityRole="link"
      accessibilityLabel={`${helper.name}. ${helper.task}. ${status}.${helper.progress ? ` ${helper.progress}.` : ""} Open its note`}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, hovered && styles.hover]}
      testID={`bot-panel-helper-${helper.path}`}
    >
      <View style={styles.face}>
        <HelperFace helper={helper.helper} via={botFace} size={28} dim={!live} />
      </View>
      <View style={styles.text}>
        <View style={styles.nameLine}>
          <Text variant="tree" numberOfLines={1} style={[styles.name, !live && styles.muted]}>
            {helper.name}
          </Text>
          {helper.usage === null ? null : (
            <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>{`${helper.usage}% of its week`}</Text>
          )}
        </View>
        <Text variant="tree" numberOfLines={1} style={live ? styles.task : styles.muted}>
          {helper.task}
        </Text>
        <View style={styles.statusLine}>
          <View aria-hidden style={[styles.dot, { borderColor: dot, backgroundColor: helper.status === "stopped" ? "transparent" : dot }]} />
          <Text variant="treeMeta" numberOfLines={1} style={styles.status}>
            <Text variant="treeMeta" style={helper.status === "waiting" ? styles.waiting : styles.muted}>
              {status}
            </Text>
            {helper.progress === null ? "" : ` · ${helper.progress}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: 2 },
    title: { color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, fontSize: pointerType.meta, marginBottom: space.x1 },
    muted: { color: colors.muted },
    row: { flexDirection: "row", alignItems: "flex-start", gap: space.x3, paddingVertical: space.x2, paddingHorizontal: space.x2, marginHorizontal: -space.x2, borderRadius: radii.sm },
    hover: { backgroundColor: colors.chipFill },
    face: { paddingTop: 2 },
    text: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
    nameLine: { flexDirection: "row", alignItems: "baseline", gap: space.x2 },
    name: { fontWeight: "600", flexShrink: 1, minWidth: 0, flexGrow: 1 },
    task: { color: colors.text },
    statusLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
    dot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5, flexShrink: 0 },
    status: { color: colors.muted, flexShrink: 1, minWidth: 0 },
    waiting: { color: colors.warnText },
    fold: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingHorizontal: space.x2, marginHorizontal: -space.x2, borderRadius: radii.sm, alignSelf: "flex-start" },
  });
