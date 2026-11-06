import { useRef, type ReactNode } from "react";
import { Modal, PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { fonts, layout, radii, space, touchType } from "../design/tokens";
import { useReducedMotion } from "../design/useReducedMotion";
import type { AccountCardRow, AccountCardSection } from "./AccountCard";

/**
 * The phone's account sheet: what the @name in the top-left corner opens.
 *
 * ## Why it is its own sheet, not the shared `Menu`
 *
 * It was the shared `Menu` sheet (the one a note's ••• opens) fed the
 * pointer card's rows, and Dev2 called it awful (2026-11-06, screenshots of
 * it): the menu row draws its mark, *then* the tick gutter, *then* the label,
 * so every workspace name started further right than @shared, New workspace
 * and Settings. A workspace that had changed got a second line saying
 * "changed", and eleven actions ran down one list with Sign out below the
 * fold. A file menu is a list of verbs; this is a place you go from, and it
 * was drawn like the verbs.
 *
 * The approved boards (project files `settings-redesign-2026-11-06/`):
 *
 *  - **Your name**, with the sun beside it: Light or Dark mode is one press
 *    and no longer a row.
 *  - **Four buttons** for the places: Settings, Meetings, Tex, Trash.
 *  - **Workspaces**, every one on one left edge: the mark in a fixed slot, the
 *    name, "yours" on the same line, and the tick or the changed dot at the
 *    right edge, where neither moves the name.
 *  - **The rest**, one line each, a value at the right ("3 left", "16 ·
 *    fine"), Sign out last.
 *
 * No Cancel row: a pull down on its top or a tap outside closes it, as every
 * iOS sheet does, and the sheet now fits without scrolling.
 *
 * The rows are the same `AccountCardRow`s the pointer card draws, so the
 * conditions on them stay in `SwitcherMenu` and cannot fork; this file only
 * decides where each one goes. `testID="menu-sheet"` is kept: it is what
 * every test and the e2e suite know the phone's sheet by.
 */
export function AccountSheet({
  title,
  detail,
  appearance,
  places,
  workspaces,
  rest,
  onSelect,
  onDismiss,
}: {
  title: string;
  detail?: string;
  /** The sun beside your name: its label names the mode it switches to. */
  appearance?: { label: string; testID: string; id: string };
  /** The four buttons. Drawn as buttons, so their `detail` is not shown. */
  places: readonly AccountCardRow[];
  workspaces: readonly AccountCardRow[];
  rest: readonly AccountCardRow[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  /*
    A pull down on the top of the sheet (the handle and your name) closes it,
    which is what stands in for the Cancel row this sheet no longer has. Only
    the top: the list below scrolls, and a scroll must never close it.
  */
  const pull = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > 60 || gesture.vy > 0.8) onDismiss();
      },
    }),
  ).current;
  const pick = (id: string) => {
    onSelect(id);
    onDismiss();
  };

  return (
    <Modal transparent visible animationType={reduced ? "none" : "slide"} onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessible={false} accessibilityLabel="Close menu" onPress={onDismiss}>
        {/* Swallows presses inside the sheet, so only the scrim dismisses. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + space.x2 }]}
          accessible={false}
          onPress={() => {}}
          accessibilityLabel={title}
          testID="menu-sheet"
        >
          <View {...pull.panHandlers}>
            <View aria-hidden style={styles.handle} />
            <View style={styles.who}>
              <View style={styles.whoText}>
                <Text role="heading" aria-level={2} numberOfLines={1} style={styles.name} testID="menu-title">
                  {title}
                </Text>
                {detail === undefined ? null : (
                  <Text numberOfLines={1} style={styles.email} testID="menu-title-detail">
                    {detail}
                  </Text>
                )}
              </View>
              {appearance === undefined ? null : (
                <PressRow
                  accessibilityLabel={appearance.label}
                  onPress={() => pick(appearance.id)}
                  radius={radii.pill}
                  style={styles.round}
                  testID={appearance.testID}
                >
                  <Icon name="sun" size={18} color={colors.text} />
                </PressRow>
              )}
            </View>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {places.length === 0 ? null : (
              <View style={styles.places}>
                {places.map((row) => (
                  <PressRow
                    key={row.id}
                    accessibilityLabel={row.accessibilityLabel ?? row.label}
                    onPress={() => pick(row.id)}
                    radius={radii.control}
                    style={styles.place}
                    hoverStyle={styles.placeHover}
                    testID={row.testID}
                  >
                    {row.leading}
                    <Text numberOfLines={1} style={styles.placeLabel}>
                      {row.label}
                    </Text>
                  </PressRow>
                ))}
              </View>
            )}

            {workspaces.length === 0 ? null : (
              <>
                <Text style={styles.group}>Workspaces</Text>
                {workspaces.map((row) => (
                  <SheetRow key={row.id} row={row} inline onPress={() => pick(row.id)} />
                ))}
              </>
            )}

            {rest.length === 0 ? null : (
              <>
                {workspaces.length === 0 && places.length === 0 ? null : <View aria-hidden style={styles.rule} />}
                {rest.map((row) => (
                  <SheetRow key={row.id} row={row} onPress={() => pick(row.id)} />
                ))}
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * One line: a mark in a fixed slot, the label, and at the right edge what it
 * is set to, a changed dot, or the tick. `inline` puts the detail beside the
 * label instead ("@seyi yours"), where it describes the name, not a value.
 */
function SheetRow({ row, inline = false, onPress }: { row: AccountCardRow; inline?: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  /*
    The dot is drawn for the same two things the pointer card dots: a
    workspace that changed (its accessible name says so) and a row whose
    badge is up (@shared, What's new). A row's own words carry it for a
    screen reader, so the dot itself is hidden.
  */
  const changed = row.badge === true || (row.accessibilityLabel !== undefined && row.accessibilityLabel !== row.label);
  return (
    <PressRow
      accessibilityLabel={row.accessibilityLabel ?? row.label}
      ariaChecked={row.checked}
      onPress={onPress}
      radius={0}
      style={styles.row}
      hoverStyle={styles.rowHover}
      testID={row.testID}
    >
      <View style={styles.slot}>{row.leading}</View>
      <Text numberOfLines={1} style={[styles.label, row.danger === true ? styles.danger : null]} testID={`sheet-label-${row.id}`}>
        {row.label}
        {inline && row.detail !== undefined ? <Text style={styles.inlineDetail}>{`  ${row.detail}`}</Text> : null}
      </Text>
      {!inline && row.detail !== undefined ? (
        <Text numberOfLines={1} style={styles.value}>
          {row.detail}
        </Text>
      ) : null}
      {changed && row.checked !== true ? <View aria-hidden style={styles.dot} testID={`sheet-dot-${row.id}`} /> : null}
      {row.checked === true ? (
        <View testID={`sheet-tick-${row.id}`}>
          <Icon name="check" size={17} color={colors.accent} />
        </View>
      ) : null}
    </PressRow>
  );
}

/** The places the phone's sheet draws as its four buttons, in this order. */
const SHEET_PLACES = ["settings", "meetings", "tex", "trash"] as const;

/**
 * The card's sections, laid out for the phone's sheet (`AccountSheet`): the
 * appearance row becomes the sun beside your name, Settings, Meetings, Tex and
 * Trash the four buttons, the workspaces their own group, and everything else
 * one line each with the exits last. Every row is the card's own
 * (`SwitcherMenu` builds them), so the conditions that decide whether a row
 * exists stay in one place.
 */
export function phoneSheetParts(sections: readonly AccountCardSection[]): {
  appearance?: AccountCardRow;
  places: AccountCardRow[];
  workspaces: AccountCardRow[];
  rest: AccountCardRow[];
} {
  const rows = (key: string) => sections.find((section) => section.key === key)?.rows ?? [];
  const others = rows("places");
  const isPlace = (row: AccountCardRow) => (SHEET_PLACES as readonly string[]).includes(row.id);
  return {
    appearance: others.find((row) => row.id === "appearance"),
    places: others.filter(isPlace),
    workspaces: rows("workspaces"),
    rest: [...others.filter((row) => !isPlace(row) && row.id !== "appearance"), ...rows("exits")],
  };
}

/** The mark slot: a workspace mark's size, so every label starts on one edge. */
export const SHEET_MARK = 28;

/** A glyph sized for the slot, for rows that have no workspace mark. */
export function SlotIcon({ children }: { children: ReactNode }) {
  return <View style={{ width: SHEET_MARK, height: SHEET_MARK, alignItems: "center", justifyContent: "center" }}>{children}</View>;
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: "rgba(3,3,4,.72)", justifyContent: "flex-end" },
    sheet: {
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      backgroundColor: colors.surface2,
      paddingTop: space.x2,
      maxHeight: "92%",
      boxShadow: shadows.rising,
    },
    handle: {
      alignSelf: "center",
      width: 38,
      height: 5,
      borderRadius: radii.pill,
      backgroundColor: colors.lineStrong,
      marginBottom: space.x2,
    },
    who: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x4,
      paddingBottom: space.x3,
    },
    whoText: { flex: 1, minWidth: 0, gap: 2 },
    name: { fontFamily: fonts.body, fontSize: touchType.body, fontWeight: "600", color: colors.text },
    email: { fontFamily: fonts.body, fontSize: touchType.meta + 1, color: colors.muted },
    round: {
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
    },
    list: { flexGrow: 0 },
    listContent: { paddingBottom: space.x2 },
    places: { flexDirection: "row", gap: space.x2, paddingHorizontal: space.x4, paddingBottom: space.x3 },
    place: {
      flex: 1,
      minWidth: 0,
      minHeight: 62,
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: space.x1,
      borderRadius: radii.control,
      backgroundColor: colors.surface3,
    },
    placeHover: { backgroundColor: colors.chromePressed },
    placeLabel: { fontFamily: fonts.body, fontSize: touchType.meta, color: colors.text },
    group: {
      fontFamily: fonts.body,
      fontSize: touchType.meta + 0.5,
      color: colors.muted,
      paddingHorizontal: space.x5,
      paddingTop: space.x1,
      paddingBottom: space.x1,
    },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: space.x2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: layout.minTouchTarget + 4,
      paddingHorizontal: space.x5,
    },
    rowHover: { backgroundColor: colors.surface3 },
    slot: { width: SHEET_MARK, height: SHEET_MARK, alignItems: "center", justifyContent: "center" },
    label: { flex: 1, minWidth: 0, fontFamily: fonts.body, fontSize: touchType.body, color: colors.text },
    inlineDetail: { fontSize: touchType.meta + 2, color: colors.muted },
    value: { flexShrink: 0, maxWidth: "45%", fontFamily: fonts.body, fontSize: touchType.ui - 1, color: colors.muted },
    danger: { color: colors.crit },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  });
