import { Pressable, Text as Inline, StyleSheet, View } from "react-native";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { pointerType, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { castTimeLabel } from "../home/cast/castTimeline";
import { StudioInlineField } from "./StudioInlineField";
import type { ScriptRow } from "./studioScript";

/**
 * One step on the script rail: when it starts, who does it, what they do,
 * and its words, which can be typed over where they stand. Pressing the row
 * opens its editor; ▶ plays the scene from it.
 */
export function StudioScriptRow({
  row,
  now,
  done,
  open,
  face,
  changedBy,
  moved,
  onPlay,
  onOpen,
  onWords,
}: {
  row: ScriptRow;
  now: boolean;
  done: boolean;
  open: boolean;
  face: string | null;
  /** Who just changed this step from outside the studio, to mark it; `undefined` when nobody did. */
  changedBy?: string | null;
  /** Its time moved because of an edit here. */
  moved: boolean;
  onPlay: () => void;
  /** Absent where the script cannot be changed. */
  onOpen?: () => void;
  onWords?: (words: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fallbackFace = useColors().muted;
  const who = row.actor === null ? null : <Inline style={styles.who}>{`${row.actor.name} `}</Inline>;
  const words =
    row.words === null ? null : onWords === undefined ? (
      <Text variant="rowSub" style={styles.words} numberOfLines={2}>
        {row.step.kind === "wait" ? `${row.words}s` : `“${row.words}”`}
      </Text>
    ) : (
      <View style={styles.wordsLine}>
        <StudioInlineField
          value={row.words}
          onCommit={onWords}
          label={row.step.kind === "wait" ? "Pause, in seconds" : `What ${row.actor?.name ?? "they"} ${row.verb}`}
          width={row.step.kind === "wait" ? 56 : undefined}
          testID={`studio-words-${row.index}`}
        />
        {row.step.kind === "wait" ? (
          <Text variant="rowSub" style={styles.unit}>
            seconds
          </Text>
        ) : null}
      </View>
    );
  const marked = changedBy !== undefined;
  return (
    <View style={[styles.row, open ? styles.rowOpen : now ? styles.rowNow : null, marked ? styles.rowChanged : null]}>
      <Pressable
        onPress={onPlay}
        accessibilityRole="button"
        accessibilityLabel={`Play from ${row.actor?.name ?? ""} ${row.says}`.trim()}
        aria-current={now ? "step" : undefined}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.play, pressed || hovered ? styles.playHover : null]}
        testID={`studio-step-${row.index}`}
      >
        <Text variant="treeMetaMono" style={[styles.time, now ? styles.timeNow : null, moved ? styles.timeMoved : null]}>
          {row.at === null ? "–" : castTimeLabel(row.at)}
        </Text>
        {row.actor === null ? (
          <View style={[styles.face, styles.waitFace, done ? styles.faded : null]}>
            <Icon name="clock" size={14} />
          </View>
        ) : (
          <View style={[styles.face, { backgroundColor: face ?? fallbackFace }, done ? styles.faded : null]}>
            {row.actor.kind === "agent" ? (
              <Icon name="robot" size={15} color="#FFFFFF" />
            ) : (
              <Inline style={styles.initial}>{row.actor.name.replace(/^@/, "").slice(0, 1).toUpperCase()}</Inline>
            )}
          </View>
        )}
      </Pressable>
      <View style={styles.body}>
        <Pressable
          onPress={onOpen}
          disabled={onOpen === undefined}
          accessibilityRole={onOpen === undefined ? undefined : "button"}
          accessibilityLabel={onOpen === undefined ? undefined : `Edit ${row.actor?.name ?? ""} ${row.says}`.trim()}
          aria-expanded={onOpen === undefined ? undefined : open}
          style={styles.head}
          testID={`studio-edit-${row.index}`}
        >
          <Text variant="rowSub" style={styles.says} numberOfLines={2}>
            {who}
            {row.verb}
          </Text>
          {marked ? (
            <View style={styles.badge}>
              <Text variant="treeMetaMono" style={styles.badgeText} numberOfLines={1}>
                {changedBy === null ? "changed" : changedBy}
              </Text>
            </View>
          ) : null}
          {onOpen === undefined ? null : <Icon name={open ? "chevronUp" : "pencil"} size={13} />}
        </Pressable>
        {words}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x2,
      minHeight: 48,
      paddingHorizontal: space.x2,
      paddingVertical: space.x1,
      borderRadius: radii.xl,
    },
    rowNow: { backgroundColor: colors.accentDim },
    rowOpen: { backgroundColor: colors.chipFill },
    rowChanged: { borderWidth: 1, borderColor: colors.accent },
    play: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 40, paddingHorizontal: space.x1, borderRadius: radii.lg },
    playHover: { backgroundColor: colors.chipFill },
    time: { width: 36, color: colors.muted },
    timeNow: { color: colors.accentText },
    timeMoved: { color: colors.warnText, fontWeight: "600" },
    face: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
    faded: { opacity: 0.5 },
    initial: { color: "#FFFFFF", fontSize: pointerType.meta, fontWeight: "700" },
    waitFace: { backgroundColor: colors.chipFill },
    body: { flex: 1, minWidth: 0, paddingTop: 2 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 36 },
    says: { flex: 1, color: colors.text },
    who: { fontWeight: "600" },
    words: { color: colors.text, paddingBottom: space.x2 },
    wordsLine: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingBottom: space.x1 },
    unit: { color: colors.muted },
    badge: { paddingHorizontal: space.x2, paddingVertical: 2, borderRadius: radii.md, backgroundColor: colors.accentDim, maxWidth: 120 },
    badgeText: { color: colors.accentText },
  });
