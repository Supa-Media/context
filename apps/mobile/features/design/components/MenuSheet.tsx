import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuActionId } from "../../console/files/menu";
import { radii, space } from "../tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../theme";
import { Icon } from "./Icon";
import type { MenuProps } from "./Menu";
import { ItemRow, Row, Separator } from "./MenuRow";
import { Text } from "./Text";

/**
 * The browser menu's sheet from the bottom edge: what `Menu.web.tsx` draws
 * below `layout.narrowBreakpoint`, where the reader is a thumb. Its own file
 * so the popover and the sheet are each one presentation; see the header of
 * `Menu.web.tsx` for why the web build needs both, and `Menu.tsx` for the
 * native sheet this one mirrors.
 */
export function MenuSheet<Id extends string = MenuActionId>({
  items: pointerItems,
  title,
  titleDetail,
  sheet,
  onSelect,
  onDismiss,
}: MenuProps<Id>) {
  const items = sheet?.items ?? pointerItems;
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
  const [openId, setOpenId] = useState<Id | null>(null);
  const insets = useSafeAreaInsets();

  const parent = items.find((item) => item.id === openId && item.items !== undefined) ?? null;
  const page = parent?.items ?? items;

  return (
    <Modal
      transparent
      animationType="slide"
      visible
      // Android's back button and, in the browser, Escape. Both mean "I am done
      // with this sheet", so both are the same callback.
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
              <View style={styles.titleBlock}>
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
                {titleDetail === undefined ? null : (
                  <Text
                    variant="treeMeta"
                    numberOfLines={1}
                    testID="menu-title-detail"
                    style={styles.titleDetail}
                  >
                    {titleDetail}
                  </Text>
                )}
              </View>
            )
          ) : (
            /**
             * The back row is the *only* way out of a submenu that does not
             * also close the sheet, so it is a full-height row of its own
             * rather than a chevron in the heading — a 44pt target, in the same
             * place every time.
             */
            <>
              {/* Drawn, not spelled — see the native half's back row. */}
              <Row
                id="back"
                label={parent.label}
                accessibilityLabel={`Back to ${parent.label}`}
                leading={<Icon name="chevronLeft" size={16} color={colors.muted} />}
                touch
                onActivate={() => setOpenId(null)}
              />
              <Separator touch />
            </>
          )}

          {parent === null && sheet?.header !== undefined ? sheet.header : null}

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            testID="menu-list"
          >
            {page.map((item) => (
              <View key={item.id}>
                {item.separatorBefore === true ? <Separator touch /> : null}
                <ItemRow
                  item={item}
                  touch
                  onActivate={() => {
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

          <Separator touch />
          <Row id="cancel" label="Cancel" touch align="center" onActivate={onDismiss} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  /* -------------------------------- sheet -------------------------------- */

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
  titleBlock: {
    paddingHorizontal: space.x5,
    paddingBottom: space.x2,
    gap: 2,
  },
  title: { color: colors.muted },
  titleDetail: { color: colors.muted },
  list: { flexGrow: 0 },
  listContent: { paddingVertical: space.x1 },
});
