/**
 * A project's List under a thumb (PhoneList and PhoneMenu artboards,
 * 2026-09-28), for somebody who may write:
 *
 * - **⋯ on every row**, a 44pt target, opening the row's menu as a sheet —
 *   and **press-and-hold** on the row opening the same one (`holdToOpen`).
 *   The sheet is the right-click menu redrawn (`phoneSheet.ts`): its priority
 *   chips are `PriorityChips`, here.
 * - **Swipe left on a task** for Assign and Backlog (`SwipeRow`), each only
 *   where the menu offers it. A swipe only ever reveals: nothing is written
 *   until a button is pressed, so a full swipe across the screen does
 *   nothing it can regret.
 * - **"Add a task" at the bottom of the page** (`PhoneAddBar`), opening the
 *   quick add composer in a sheet, for the first To do.
 *
 * `PanResponder` rather than the gesture handler, for the reason the
 * explorer's resizer gives: it is the one gesture API that behaves the same
 * under react-native-web and on a device. A member's rows are drawn with none
 * of this: the callers pass no controls.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { layout, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../../../design/theme";
import type { MenuItem } from "../../menuItem";
import type { FolderItem } from "../model";
import { QuickAddComposer } from "./QuickAddComposer";
import { swipeActions, type SwipeAction } from "./phoneSheet";
import type { TaskMenuModel } from "./useTaskMenu";
import type { TaskControls } from "./useTaskActions";

const TARGET = layout.minTouchTarget;
/** Each swipe button's width (PhoneList artboard). */
const ACTION_WIDTH = 78;
/** How far a finger travels sideways before a swipe is a swipe and not a tap or a scroll. */
const SWIPE_SLOP = 10;
/** A press held this long opens the sheet: the platform's own long press. */
export const HOLD_MS = 450;

/** Where a press landed, for whatever the menu opens next to. */
function anchorOf(event: GestureResponderEvent | undefined): { x: number; y: number } {
  const native = event?.nativeEvent as { pageX?: number; pageY?: number } | undefined;
  return { x: native?.pageX ?? 0, y: native?.pageY ?? 0 };
}

/**
 * The row's own press-and-hold, spread onto its `Pressable`: the menu, as a
 * sheet. Nothing for who may not write, or in a wide browser, where the row
 * has a pointer and the right-click is its menu. A device build always has
 * it: a finger has no right button, however wide the screen.
 */
export function holdToOpen(item: FolderItem, controls: TaskControls | null, compact: boolean) {
  if (controls === null || (!compact && Platform.OS === "web")) return {};
  return {
    onLongPress: (event: GestureResponderEvent) => void controls.openMenu(item, anchorOf(event)),
    delayLongPress: HOLD_MS,
  };
}

/** The ⋯ at a row's right, opening its menu as a sheet. */
export function MoreButton({ item, controls }: { item: FolderItem; controls: TaskControls }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={(event) => void controls.openMenu(item, anchorOf(event))}
      role="button"
      aria-haspopup="menu"
      accessibilityLabel={`More for ${item.label}`}
      style={styles.more}
      testID="task-more"
    >
      <Icon name="more" size={18} color={colors.chromeMuted} />
    </Pressable>
  );
}

/** The sheet's first row: a task's priority, one tap each. */
export function PriorityChips({ chips, onPick }: { chips: readonly MenuItem<string>[]; onPick: (id: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.chips} role="radiogroup" accessibilityLabel="Priority" testID="task-sheet-priorities">
      {chips.map((chip) => (
        <Pressable
          key={chip.id}
          onPress={() => onPick(chip.id)}
          role="radio"
          aria-checked={chip.checked === true}
          accessibilityLabel={chip.id === "priority:none" ? "No priority" : chip.label}
          style={[styles.chip, chip.checked === true && styles.chipOn]}
          testID="task-sheet-priority"
        >
          {chip.leading}
          <Text variant="meta" numberOfLines={1} style={chip.checked === true ? styles.chipTextOn : styles.chipText}>
            {chip.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A task row that slides left to show Assign and Backlog. What it offers is
 * asked of the menu when the swipe starts, so it is what the menu would offer
 * this row at that moment; with nothing to offer, the gesture is left alone
 * for the page to scroll.
 */
export function SwipeRow({
  item,
  controls,
  menu,
  children,
}: {
  item: FolderItem;
  controls: TaskControls | null;
  menu: TaskMenuModel | null | undefined;
  children: ReactNode;
}) {
  if (controls === null || menu == null) return <>{children}</>;
  return (
    <Swiping path={item.path} menu={menu}>
      {children}
    </Swiping>
  );
}

function Swiping({ path, menu, children }: { path: string; menu: TaskMenuModel; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const [actions, setActions] = useState<readonly SwipeAction[]>([]);
  const [open, setOpen] = useState(false);
  const offset = useRef(new Animated.Value(0)).current;
  // Read by a responder built once: a rebuild mid-gesture starts `dx` again from nothing (see `resizers.tsx`).
  const live = useRef({ path, menu });
  live.current = { path, menu };
  const rest = useRef(0);
  const start = useRef(0);
  const width = useRef(0);

  const responder = useMemo(() => {
    const clamp = (x: number) => Math.max(-width.current, Math.min(0, x));
    const settleAt = (to: number) => {
      rest.current = to;
      setOpen(to !== 0);
      if (to === 0) setActions([]);
      Animated.timing(offset, { toValue: to, duration: 160, useNativeDriver: Platform.OS !== "web" }).start();
    };
    return {
      settleAt,
      handlers: PanResponder.create({
        // Capture, so a sideways drag is taken from the row's own press before it becomes a tap.
        onMoveShouldSetPanResponderCapture: (_event, gesture) => {
          if (Math.abs(gesture.dx) < SWIPE_SLOP || Math.abs(gesture.dx) < Math.abs(gesture.dy) * 1.5) return false;
          if (rest.current === 0 && gesture.dx > 0) return false;
          const found = swipeActions(live.current.menu.itemsFor(live.current.path) ?? []);
          if (found.length === 0) return false;
          width.current = found.length * ACTION_WIDTH;
          setActions(found);
          return true;
        },
        onPanResponderGrant: () => {
          start.current = rest.current;
        },
        onPanResponderMove: (_event, gesture) => offset.setValue(clamp(start.current + gesture.dx)),
        onPanResponderTerminationRequest: () => false,
        // Past halfway it stays open; never further than its buttons, however far the finger went.
        onPanResponderRelease: (_event, gesture) => settleAt(clamp(start.current + gesture.dx) < -width.current / 2 ? -width.current : 0),
        onPanResponderTerminate: () => settleAt(rest.current),
      }).panHandlers,
    };
  }, [offset]);

  const run = (action: SwipeAction) => {
    responder.settleAt(0);
    live.current.menu.select(live.current.path, action.id, { x: 0, y: 0 });
  };
  return (
    <View style={styles.swipe}>
      {actions.length === 0 ? null : (
        <View style={styles.actions}>
          {actions.map((action) => (
            <Pressable
              key={action.id}
              onPress={() => run(action)}
              role="button"
              accessibilityLabel={action.accessibilityLabel}
              style={[styles.action, action.id === "me" ? styles.actionAssign : styles.actionPark]}
              testID={`task-swipe-${action.id}`}
            >
              <Text variant="meta" style={styles.actionText}>
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Animated.View style={[styles.slide, { transform: [{ translateX: offset }] }]} {...responder.handlers}>
        {children}
        {open ? (
          // While open, a tap on the row puts it back rather than opening it.
          <Pressable style={StyleSheet.absoluteFill} onPress={() => responder.settleAt(0)} accessibilityLabel="Close" testID="task-swipe-close" />
        ) : null}
      </Animated.View>
    </View>
  );
}

/**
 * "Add a task", pinned to the bottom of a project's page on a phone. It opens
 * the quick add composer in a sheet above the keyboard; a task added there
 * lands in the folder's first To do, said with an Undo like any other.
 */
export function PhoneAddBar({ controls, label, groupLabel }: { controls: TaskControls; label: string; groupLabel: string }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [writing, setWriting] = useState(false);
  return (
    <View style={[styles.barWrap, Platform.OS === "web" && styles.sticky]}>
      <Pressable onPress={() => setWriting(true)} role="button" accessibilityLabel={label} style={styles.bar} testID="task-phone-add">
        <Icon name="plus" size={18} color={colors.accent} />
        <Text variant="treeTouch" style={styles.barText}>
          {label}
        </Text>
      </Pressable>
      {writing ? (
        <Modal transparent visible animationType="slide" onRequestClose={() => setWriting(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.scrim}>
            <Pressable style={styles.scrimFill} accessibilityLabel="Close" onPress={() => setWriting(false)} />
            <View style={[styles.sheet, { paddingBottom: insets.bottom + space.x3 }]} testID="task-phone-add-sheet">
              <QuickAddComposer
                onAdd={(task) => controls.addTask(controls.firstToDo, task)}
                onCancel={() => setWriting(false)}
                groupLabel={groupLabel}
                {...(controls.owners === undefined ? {} : { owners: controls.owners })}
                tagSuggestions={controls.tagSuggestions}
              />
            </View>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    more: { minWidth: TARGET, minHeight: TARGET, alignItems: "center", justifyContent: "center", marginRight: -space.x3, flexShrink: 0 },
    chips: { flexDirection: "row", gap: 6, paddingHorizontal: space.x4, paddingBottom: space.x3 },
    chip: {
      flex: 1,
      minWidth: 0,
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      gap: space.x1,
      borderRadius: radii.xl,
      backgroundColor: colors.chipFill,
    },
    chipOn: { backgroundColor: colors.accentDim },
    chipText: { color: colors.text2 },
    chipTextOn: { color: colors.accentText },
    swipe: { position: "relative", overflow: "hidden" },
    slide: { backgroundColor: colors.pageSurface },
    actions: { position: "absolute", top: 0, right: 0, bottom: 0, flexDirection: "row" },
    action: { width: ACTION_WIDTH, minWidth: TARGET, minHeight: TARGET, alignItems: "center", justifyContent: "center" },
    actionAssign: { backgroundColor: colors.chromePressed },
    actionPark: { backgroundColor: colors.chrome },
    actionText: { color: colors.text, fontWeight: "600" },
    barWrap: { marginTop: space.x4, paddingBottom: space.x2 },
    sticky: { position: "sticky", bottom: space.x3, zIndex: 3 } as never,
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 52,
      paddingHorizontal: space.x4,
      borderWidth: 1.5,
      borderColor: colors.accent,
      borderRadius: radii.control,
      backgroundColor: colors.surface,
      boxShadow: shadows.floating,
    } as never,
    barText: { color: colors.chromeMuted },
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
    scrimFill: { flex: 1 },
    sheet: {
      paddingTop: space.x3,
      paddingHorizontal: space.x3,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
  });
