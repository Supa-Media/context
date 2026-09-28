/**
 * The List's controls around a task row, for somebody who may write
 * (`TaskControls`): the frame that picks a row up, takes a drop by band and
 * opens its menu on a right-click; the checkbox a selection starts from; the
 * "+ Subtask" a row offers on hover; and the "+ Add task" / "+ Add subtask"
 * lines that open the composer in place.
 *
 * A member's rows are drawn without any of these — the caller passes no
 * controls — so there is nothing to press that would write.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../../../design/theme";
import { useRightClick } from "../../rightClick";
import { useCardDrag, useColumnDrop, useRowDrop, type RowZone } from "../boardDrag";
import type { FolderItem } from "../model";
import { SwipeRow } from "./PhoneParts";
import { QuickAddComposer } from "./QuickAddComposer";
import type { TaskMenuModel } from "./useTaskMenu";
import type { DropVerdict } from "./taskDrop";
import type { TaskControls } from "./useTaskActions";
import { keyboardFocus } from "../rowCells";

/** Whether a press asked to pick the row rather than open it: Shift, ⌘ or Ctrl held. */
export function isPickPress(event: GestureResponderEvent | undefined): boolean {
  const native = (event as unknown as { nativeEvent?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } } | undefined)?.nativeEvent;
  const raw = (native ?? event) as { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } | undefined;
  return raw?.shiftKey === true || raw?.metaKey === true || raw?.ctrlKey === true;
}

/** One callback for several refs on one node. */
function allRefs(...refs: ((node: unknown) => unknown)[]) {
  return (node: unknown) => {
    for (const ref of refs) ref(node);
  };
}

const NO_REF = () => undefined;

/**
 * A row that can be picked up, dropped on by band, and right-clicked. The
 * hint says what letting go here would do — or why it won't — before it is
 * let go.
 */
export function RowFrame({
  item,
  controls,
  note = false,
  swipe = null,
  children,
}: {
  item: FolderItem;
  controls: TaskControls | null;
  /** A plain note: it has a menu, and is neither picked up nor dropped on. */
  note?: boolean;
  /** On a phone, the row's menu: a swipe left offers its Assign and Backlog (`PhoneParts.tsx`). */
  swipe?: TaskMenuModel | null;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const [zone, setZone] = useState<RowZone | null>(null);
  const enabled = controls !== null && !note;
  const drag = useCardDrag({
    path: item.path,
    enabled,
    onStart: () => controls?.startDrag(item.path),
    onEnd: () => {
      setZone(null);
      controls?.endDrag();
    },
  });
  const takesDrop = enabled && controls !== null && controls.dragging !== null && controls.dragging !== item.path;
  const drop = useRowDrop({
    enabled: takesDrop,
    onOver: (next) => setZone((current) => (current === next ? current : next)),
    onDrop: (at) => {
      setZone(null);
      if (controls !== null) controls.drop(controls.rowVerdict(item, at));
    },
  });
  const menu = useRightClick(controls === null ? undefined : (anchor) => controls.openMenu(item, anchor));
  const verdict: DropVerdict = zone === null || controls === null || !takesDrop ? { kind: "none" } : controls.rowVerdict(item, zone);
  return (
    <View
      ref={allRefs(drag, drop, menu.ref ?? NO_REF) as never}
      collapsable={false}
      style={[
        styles.frame,
        verdict.kind !== "none" && zone === "middle" && (verdict.kind === "refused" ? styles.refused : styles.nest),
        verdict.kind !== "none" && zone === "above" && styles.lineAbove,
        verdict.kind !== "none" && zone === "below" && styles.lineBelow,
      ]}
      testID="task-row-frame"
    >
      {swipe == null || note ? (
        children
      ) : (
        <SwipeRow item={item} controls={controls} menu={swipe}>
          {children}
        </SwipeRow>
      )}
      {verdict.kind === "none" ? null : (
        <View style={[styles.hint, verdict.kind === "refused" && styles.hintRefused]} role="status" testID="task-drop-hint">
          <Text variant="treeMeta" style={verdict.kind === "refused" ? styles.hintRefusedText : styles.hintText}>
            {verdict.hint}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * A section or a folded band that takes a dragged task: its status, or
 * Backlog. `hint` draws what letting go would do, while a task is over it.
 */
export function DropArea({
  controls,
  status,
  park = false,
  children,
  testID,
}: {
  controls: TaskControls | null;
  status: string;
  /** The Backlog band: a drop parks the row (`TaskControls.parkVerdict`) — into the Backlog folder where there is one. */
  park?: boolean;
  children: (hint: string | null) => ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [over, setOver] = useState(false);
  const enabled = controls !== null && controls.dragging !== null;
  const ref = useColumnDrop({
    enabled,
    onOver: setOver,
    onDrop: () => {
      setOver(false);
      if (controls !== null) controls.drop(park ? controls.parkVerdict() : controls.statusVerdict(status));
    },
  });
  const verdict = over && enabled && controls !== null ? (park ? controls.parkVerdict() : controls.statusVerdict(status)) : null;
  const hint = verdict === null || verdict.kind === "none" ? null : verdict.hint;
  return (
    <View ref={ref as never} collapsable={false} style={hint === null ? undefined : styles.areaOver} testID={testID}>
      {children(hint)}
    </View>
  );
}

/** The selection's checkbox: on hover, or on every row once anything is picked. */
export function PickBox({ picked, shown, label, onPick }: { picked: boolean; shown: boolean; label: string; onPick: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPick}
      role="checkbox"
      aria-checked={picked}
      accessibilityLabel={`Select ${label}`}
      hitSlop={6}
      style={[styles.box, picked && styles.boxOn, !shown && !picked && styles.quiet]}
      testID="task-pick"
    >
      {picked ? <Icon name="check" size={10} color={colors.white} /> : null}
    </Pressable>
  );
}

/** "+" for a subtask, on a task row's hover: a mark, so it covers as little of the name as it can. */
export function SubtaskButton({ shown, onPress }: { shown: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onFocus={(event) => setFocused(keyboardFocus(event))}
      onBlur={() => setFocused(false)}
      role="button"
      accessibilityLabel="Add a subtask"
      // The words the mark stands for, under the pointer.
      {...({ title: "Add a subtask" } as object)}
      style={[styles.mini, styles.miniMark, !shown && !focused && styles.quiet]}
      testID="task-add-subtask"
    >
      <Icon name="plus" size={12} color={colors.text2} />
    </Pressable>
  );
}

/** A quiet "+ Add task" line at the end of a group, or "+ Add subtask" under an opened task. */
export function AddLine({ label, nested = false, onPress, testID }: { label: string; nested?: boolean; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel={label.replace(/^\+ /, "")}
      style={[styles.addLine, nested && styles.nested]}
      testID={testID}
    >
      <Text variant="tree" style={hovered ? styles.addTextHover : styles.addText}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Under an opened task: "+ Add subtask", or the one-line composer once pressed. */
export function SubtaskAdder({ parent, controls }: { parent: FolderItem; controls: TaskControls }) {
  const styles = useThemedStyles(makeStyles);
  const open = controls.composer?.kind === "subtask" && controls.composer.parent === parent.path;
  if (!open) {
    return <AddLine label="+ Add subtask" nested onPress={() => controls.openComposer({ kind: "subtask", parent: parent.path })} testID="task-add-subtask-line" />;
  }
  return (
    <View style={styles.nested}>
      <QuickAddComposer compact onAdd={(task) => controls.addSubtask(parent.path, task)} onCancel={controls.closeComposer} />
    </View>
  );
}

/** A group's full composer, for a task in `status`. */
export function TaskComposer({ controls, status, groupLabel }: { controls: TaskControls; status: string; groupLabel: string }) {
  return (
    <QuickAddComposer
      onAdd={(task) => controls.addTask(status, task)}
      onCancel={controls.closeComposer}
      groupLabel={groupLabel}
      {...(controls.owners === undefined ? {} : { owners: controls.owners })}
      tagSuggestions={controls.tagSuggestions}
    />
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    frame: { position: "relative" },
    areaOver: { borderRadius: radii.md, outlineWidth: 1.5, outlineStyle: "dashed", outlineColor: colors.accent } as never,
    nest: { borderRadius: radii.sm, outlineWidth: 1.5, outlineStyle: "solid", outlineColor: colors.accent, backgroundColor: colors.rowSelected } as never,
    refused: { borderRadius: radii.sm, outlineWidth: 1.5, outlineStyle: "dashed", outlineColor: colors.critBorder } as never,
    lineAbove: { borderTopWidth: 2, borderTopColor: colors.accent, marginTop: -2 },
    lineBelow: { borderBottomWidth: 2, borderBottomColor: colors.accent, marginBottom: -2 },
    hint: {
      position: "absolute",
      right: space.x2,
      bottom: -space.x3,
      zIndex: 2,
      pointerEvents: "none",
      paddingHorizontal: space.x2,
      paddingVertical: 2,
      borderRadius: radii.sm,
      backgroundColor: colors.accent,
      boxShadow: shadows.floating,
    } as never,
    hintRefused: { backgroundColor: colors.critWash, borderWidth: 1, borderColor: colors.critBorder },
    hintText: { color: colors.white },
    hintRefusedText: { color: colors.critText },
    box: {
      width: 14,
      height: 14,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      borderRadius: 3,
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    quiet: { opacity: 0 },
    mini: {
      flexShrink: 0,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
      borderRadius: radii.sm,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
    },
    miniText: { color: colors.text2 },
    miniMark: { paddingVertical: 4 },
    addLine: { paddingVertical: space.x2, paddingLeft: space.x6 + 2 },
    nested: { paddingLeft: 42 },
    addText: { color: colors.chromeMuted },
    addTextHover: { color: colors.text2 },
  });
