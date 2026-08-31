import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuActionId, MenuItem } from "../../console/files/menu";
import { radii, space } from "../tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../theme";
import { PressRow } from "./Button";
import { Icon } from "./Icon";
import { Text } from "./Text";

/**
 * The action menu — **native**, which is always a thumb.
 *
 * `features/console/files/menu.ts` decides *what* to offer; this file and its
 * `.web.tsx` sibling decide what that looks like. The split is the same one
 * `clipboard.ts` / `clipboard.web.ts` uses, but note carefully what it does and
 * does not decide:
 *
 *  - A finger has no right button. The gesture is a **long press**, and the
 *    answer is a sheet from the bottom edge — what iOS and Android already do
 *    everywhere else, and what Obsidian mobile does for exactly this menu.
 *    That is this file, and it is unconditional: an iOS or Android build has
 *    no other input device to serve.
 *  - **A browser is not a device.** `Menu.web.tsx` therefore does *not* mean
 *    "pointer": it means "the browser", and it picks between a popover at the
 *    pointer and this same sheet on `layout.narrowBreakpoint`, exactly as
 *    `Palette.tsx` does. The web build is how this product reaches phones, so
 *    a `.web.tsx` that only knew how to draw a popover put a 28px row under a
 *    thumb — see its header.
 *
 * Neither file imports the other. A platform module cannot: on web, `./Menu`
 * resolves to `Menu.web.tsx`, so a `.web` file importing `./Menu` would import
 * itself. `MenuProps` is therefore declared identically in both, the sheet's
 * chrome is written out in both, and the two are held together by
 * `MenuActionId` and `MenuItem`, which they share and neither owns. Within
 * each file there is exactly one row component, which is the duplication that
 * would actually hurt: geometry is obvious when it is wrong, and a missing
 * danger colour is not.
 *
 * ## What is deliberately different here, not merely rescaled
 *
 *  - **Rows are at least 44pt tall.** A pointer lands where it is aimed; a
 *    thumb lands within about 10mm of where it is aimed. A 28px row that is
 *    fine on a desktop is a mis-tap next to "Delete forever…" on a phone.
 *  - **A submenu pushes a page, it does not nest.** A popover hanging off the
 *    side of another popover needs somewhere to hang and a hover to open it,
 *    and a phone has neither. Visibility becomes a second page of the same
 *    sheet with a way back, which is the pattern every mobile settings screen
 *    already taught the person holding it.
 *  - **No shortcut column.** `menu.ts` omits `shortcut` entirely when
 *    `platform: "touch"`, so there is nothing to draw — and nothing here adds
 *    it back. A column of chords nobody can type costs a fifth of the width of
 *    a phone.
 *  - **A Cancel row.** Dismissing by tapping the scrim works, but it is not
 *    discoverable, and on a sheet whose last item is destructive the visible
 *    way out matters.
 */
export interface MenuProps {
  items: MenuItem[];
  /** Where the pointer was. Web anchors a popover here; touch ignores it. */
  anchor?: { x: number; y: number };
  /** Sheet heading on touch — the file name. Web shows no heading. */
  title?: string;
  onSelect: (id: MenuActionId) => void;
  onDismiss: () => void;
}

/**
 * One row. The whole row is the target, and the label carries the danger
 * colour rather than the row carrying a red fill: a filled red row on a sheet
 * reads as the *recommended* action on iOS, which is the opposite of what
 * "Delete forever…" is.
 */
function SheetRow({
  id,
  label,
  detail,
  accessibilityLabel,
  danger = false,
  leading,
  trailing,
  align = "left",
  onPress,
}: {
  id: string;
  label: string;
  /** A second line, for an outcome the verb cannot carry alone. */
  detail?: string;
  /**
   * The accessible name, where the visible label is not a whole one.
   *
   * The back row is the case: it draws the parent's name beside a chevron,
   * which a person reads as "back to Visibility" and a screen reader would
   * otherwise announce as a second button called "Visibility".
   */
  accessibilityLabel?: string;
  danger?: boolean;
  /** A mark before the label. Decorative — the accessible name is `label`. */
  leading?: ReactNode;
  trailing?: ReactNode;
  align?: "left" | "center";
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      radius={radii.md}
      testID={`menu-item-${id}`}
      // `PressRow` takes one style object rather than an array, so the two
      // shapes are merged here rather than layered.
      style={StyleSheet.flatten([styles.row, align === "center" && styles.rowCentered])}
      hoverStyle={styles.rowHover}
    >
      {leading}
      {/*
        The label and its detail are one column so the row stays a row: a
        second `Text` beside the first would sit next to it and push the
        chevron off the edge.
      */}
      <View style={styles.labelColumn} testID={`menu-labels-${id}`}>
        <Text
          variant="body"
          numberOfLines={1}
          testID={`menu-label-${id}`}
          style={danger ? styles.dangerLabel : undefined}
        >
          {label}
        </Text>
        {detail === undefined ? null : (
          // Two lines, not one: this is a phone, and the sentence it carries
          // is the reason somebody presses one of these rather than the other.
          <Text variant="treeMeta" numberOfLines={2} testID={`menu-detail-${id}`}>
            {detail}
          </Text>
        )}
      </View>
      {trailing}
    </PressRow>
  );
}

/** `separatorBefore` — a hairline with air around it, never a heavy rule. */
function Separator() {
  const styles = useThemedStyles(makeStyles);
  return <View aria-hidden style={styles.separator} />;
}

export function Menu({ items, title, onSelect, onDismiss }: MenuProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  /**
   * Which submenu is open, by the id of its **parent** item.
   *
   * Held as an id rather than as the item itself so that a re-render with new
   * items (a clipboard filled while the sheet is open) cannot leave a stale
   * copy of a page on screen: the parent is looked up again every render, and
   * an id that no longer exists collapses back to the first page.
   */
  const [openId, setOpenId] = useState<MenuActionId | null>(null);
  const insets = useSafeAreaInsets();

  const parent = items.find((item) => item.id === openId && item.items !== undefined) ?? null;
  const page = parent?.items ?? items;

  return (
    <Modal
      transparent
      animationType="slide"
      visible
      // Android's back button and, on the web build of this component, Escape.
      // Both mean "I am done with this sheet", so both are the same callback.
      onRequestClose={onDismiss}
    >
      <Pressable style={styles.scrim} accessibilityLabel="Close menu" onPress={onDismiss}>
        {/* Swallow presses inside the sheet, so only the scrim dismisses. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + space.x2 }]}
          onPress={() => {}}
          accessibilityLabel={title ?? "Actions"}
          testID="menu-sheet"
        >
          <View aria-hidden style={styles.handle} />

          {parent === null ? (
            title === undefined ? null : (
              <Text
                variant="rowSub"
                numberOfLines={1}
                role="heading"
                aria-level={2}
                testID="menu-title"
                style={styles.title}
              >
                {title}
              </Text>
            )
          ) : (
            /**
             * The back row is the *only* way out of a submenu that does not
             * also close the sheet, so it is a full-height row of its own
             * rather than a chevron in the heading — a 44pt target, in the same
             * place every time.
             */
            <>
              {/*
                The chevron is drawn, not spelled. `‹` inside `label` made it
                part of the *accessible name* — "single left-pointing angle
                quotation mark, Visibility" — because `SheetRow` passes the
                same string to `accessibilityLabel`. An icon in `leading` is
                hidden from the name and is the same mark to look at.
              */}
              <SheetRow
                id="back"
                label={parent.label}
                accessibilityLabel={`Back to ${parent.label}`}
                leading={<Icon name="chevronLeft" size={16} color={colors.muted} />}
                onPress={() => setOpenId(null)}
              />
              <Separator />
            </>
          )}

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            testID="menu-list"
          >
            {page.map((item) => (
              <View key={item.id}>
                {item.separatorBefore === true ? <Separator /> : null}
                <SheetRow
                  id={item.id}
                  label={item.label}
                  detail={item.detail}
                  danger={item.danger === true}
                  trailing={
                    item.items === undefined ? null : (
                      <Icon name="chevronRight" size={16} color={colors.muted} />
                    )
                  }
                  onPress={() => {
                    /**
                     * A parent is never dispatched. `menu.ts` gives the
                     * Visibility item the id `"visibility"`, which has no
                     * handler precisely so that a mistake here is a no-op
                     * rather than a privacy change — but the check is what
                     * keeps it from being one at all.
                     */
                    if (item.items !== undefined) {
                      setOpenId(item.id);
                      return;
                    }
                    onSelect(item.id);
                    onDismiss();
                  }}
                />
              </View>
            ))}
          </ScrollView>

          <Separator />
          <SheetRow id="cancel" label="Cancel" align="center" onPress={onDismiss} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: radii.floating,
    borderTopRightRadius: radii.floating,
    borderTopWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
    paddingTop: space.x2,
    // A sheet that grows past this stops looking like a sheet and starts
    // looking like a screen you cannot leave; the list scrolls instead.
    maxHeight: "80%",
    boxShadow: shadows.rising,
  },
  handle: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.lineStrong,
    marginBottom: space.x2,
  },
  title: {
    paddingHorizontal: space.x5,
    paddingBottom: space.x2,
    color: colors.muted,
  },
  list: { flexGrow: 0 },
  listContent: { paddingVertical: space.x1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x3,
    // The thumb target. 44pt is the floor, not the aim: the padding takes an
    // ordinary single-line row past it, and this keeps a short label honest.
    minHeight: 44,
    paddingVertical: space.x3,
    paddingHorizontal: space.x5,
  },
  rowCentered: { justifyContent: "center" },
  /**
   * The label and its detail, stacked.
   *
   * `flexShrink` and **not** `flex: 1`. A column that grows fills the row, and
   * the row's `justifyContent: "center"` then has nothing left to centre — which
   * silently left-aligns the Cancel row, the one row on this sheet that is
   * centred on purpose. Sized to its content, the chevron sits beside the label
   * exactly where it did before a second line was possible.
   */
  labelColumn: { flexShrink: 1, gap: 2 },
  rowHover: { backgroundColor: colors.surface3 },
  dangerLabel: { color: colors.critText },
  chevron: { marginLeft: "auto", color: colors.muted },
  separator: {
    height: 1,
    backgroundColor: colors.line,
    marginVertical: space.x2,
  },
});
