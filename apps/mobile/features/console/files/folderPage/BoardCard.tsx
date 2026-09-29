/**
 * One card on a project's Board (the approved artboard): its priority and
 * first tag, its name, how far along it is — a bar and "2/4" — for a
 * task that holds subtasks, when it is due, and whose it is as a face.
 *
 * Moving it is its status, two ways that land in the same write: drag it to
 * another column with a pointer (`boardDrag.web.ts`), or press its status
 * and pick — the only way on a phone or from a keyboard, so for somebody who
 * may write it is always drawn, never hidden until hover. A member sees the
 * card with nothing to press but the card itself.
 *
 * A card is `chipFill` on a `line` hairline, not `surface2` — in the dark
 * palette `surface2` is the page, and the card would vanish.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useCardDrag } from "./boardDrag";
import { OwnerFace, PriorityGlyph } from "./Glyphs";
import type { ItemActions } from "./items";
import { NEW_FRONT_NOTE, type FolderItem } from "./model";
import { progressPercent } from "./ProgressMeter";
import { PropertyValue } from "./PropertyValue";
import { faceFor } from "./taskFace";
import { dueOf, dueWord, ownersOf, tagsOf } from "./taskProps";

export function BoardCard({
  item,
  now,
  actions,
  compact,
  done,
  lifted,
  onLift,
}: {
  item: FolderItem;
  now: number;
  actions: ItemActions;
  compact: boolean;
  /** In a Done column: its name is drawn a step quieter. */
  done: boolean;
  lifted: boolean;
  onLift: (lifted: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const edit = actions.onChoose;
  const ref = useCardDrag({ path: item.path, enabled: edit !== null, onStart: () => onLift(true), onEnd: () => onLift(false) });
  const tag = tagsOf(item.properties)[0];
  const due = dueOf(item.properties);
  const owners = ownersOf(item.properties);
  const progress = item.progress;
  const selected = actions.selected === item.path;
  return (
    <View ref={ref as never} style={lifted && styles.lifted} testID="folder-card-drag">
      <Pressable
        onPress={() => actions.onOpen(item)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="link"
        aria-current={selected ? "true" : undefined}
        accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
        style={[styles.card, hovered && styles.cardHover, selected && styles.cardSelected, edit !== null && !compact && styles.grab]}
        testID="folder-card"
      >
        {item.priority === null && tag === undefined ? null : (
          <View style={styles.line}>
            <PriorityGlyph priority={item.priority} />
            <View style={styles.push} />
            {tag === undefined ? null : (
              <Text variant="meta" numberOfLines={1} style={styles.tag} testID="folder-card-tag">
                {isolateForDisplay(tag)}
              </Text>
            )}
          </View>
        )}
        <Text variant="body" numberOfLines={2} style={done ? styles.nameDone : styles.name}>
          {item.label}
        </Text>
        {progress === null ? null : (
          <View
            style={styles.bar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label={`${progress.done} of ${progress.total} done`}
            testID="folder-card-bar"
          >
            <View style={[styles.fill, { width: `${progressPercent(progress.done, progress.total)}%` }]} />
          </View>
        )}
        <View style={styles.line}>
          {progress === null ? null : (
            <Text variant="meta" numberOfLines={1} style={styles.fraction} testID="folder-card-progress">
              {`${progress.done}/${progress.total}`}
            </Text>
          )}
          {due === null ? null : (
            <Text variant="meta" numberOfLines={1} style={styles.meta} testID="folder-card-due">
              {`Due ${dueWord(due, now)}`}
            </Text>
          )}
          <View style={styles.push} />
          {edit === null ? null : (
            <PropertyValue
              property="status"
              value={item.status}
              choices={actions.choices("status")}
              sections={actions.statusMenu}
              onEditList={actions.onEditStatuses}
              savesTo={item.creates ? NEW_FRONT_NOTE : null}
              onChoose={(value) => edit(item, "status", value)}
              variant="meta"
              style={styles.meta}
              testID="folder-card-status"
            />
          )}
          <OwnerFace face={faceFor(actions, owners[0])} />
          {owners.length > 1 ? (
            <Text variant="meta" style={styles.meta} accessibilityLabel={`and ${owners.length - 1} more`} testID="folder-card-more-owners">
              {`+${owners.length - 1}`}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.chipFill,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      paddingVertical: space.x3,
      paddingHorizontal: space.x3,
      gap: space.x2,
    },
    cardHover: { borderColor: colors.lineStrong },
    cardSelected: { borderColor: colors.accent },
    // Web only, and not in `ViewStyle`s cursor names: asserted through, as `AppFrame` does for its resize cursor.
    grab: { cursor: "grab" as unknown as ViewStyle["cursor"] },
    lifted: { opacity: 0.4 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
    push: { flexGrow: 1, flexShrink: 1 },
    tag: {
      flexShrink: 1,
      color: colors.muted,
      backgroundColor: colors.chipFill,
      borderRadius: radii.sm,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
    },
    name: { color: colors.text },
    nameDone: { color: colors.muted },
    bar: { height: 4, borderRadius: 2, backgroundColor: colors.lineStrong, overflow: "hidden" },
    fill: { height: "100%", backgroundColor: colors.accent },
    meta: { flexShrink: 1, color: colors.muted },
    fraction: { flexShrink: 0, color: colors.muted, fontVariant: ["tabular-nums"] },
  });
