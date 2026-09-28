import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type Role } from "react-native";
import type { MenuItem } from "../../console/files/menu";
import { radii, space } from "../tokens";
import { ROW_HEIGHT, TOUCH_ROW_MIN_HEIGHT, DETAIL_BLOCK } from "./menuGeometry";
import { useColors, useThemedStyles, type Colors } from "../theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

/**
 * The browser menu's rows, shared by its two presentations — the popover at
 * the pointer and the sheet from the bottom (`Menu.web.tsx`, `MenuSheet.tsx`).
 * Extracted from `Menu.web.tsx` so each presentation is a file of its own;
 * nothing here decides which one is drawn.
 */

/* -------------------------------------------------------------------------- */
/*                                  the row                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row, both presentations.
 *
 * It takes flat fields rather than a `MenuItem` because two of the rows on a
 * sheet — the back row and Cancel — are chrome rather than menu items, and
 * giving them a synthetic `MenuItem` with an id that is not a `MenuActionId`
 * would be a lie in the one type that keeps the model and its drawings
 * together.
 *
 * `touch` changes density and nothing else:
 *
 *  - **height** — a fixed 28px, because the popover's placement arithmetic
 *    imposes it, against a 44pt *minimum* that the label is allowed to exceed.
 *  - **no chord column.** `menu.ts` omits `shortcut` entirely at compact
 *    density, so on a phone there is normally nothing to draw; this is the
 *    other end of that promise — nothing here puts a chord back on a device
 *    with no keyboard, whatever it was handed.
 *  - **danger stays danger under a thumb.** A lit pointer row recolours its
 *    label to the accent, which is fine when the highlight follows a cursor.
 *    On a sheet the highlight is a press, and a "Delete forever…" that turns
 *    blue under the finger about to release on it is the sheet lying about
 *    what it is offering. Touch lights the background instead.
 */
/**
 * `menuitemradio` where the row carries a state, `menuitem` where it does not.
 *
 * Saying so is not decoration: a screen reader announcing "Use the folder's
 * setting" with no mention of its being the one in force has given a blind
 * reader strictly less than the check gives everybody else — on the control
 * that decides who can read a note.
 *
 * React Native's `Role` union predates this menu and has no `menuitemradio` in
 * it. react-native-web writes the value straight through to the DOM and on the
 * web ARIA is the authority, so the cast is correct and it is contained here
 * rather than spread across the element. `aria-checked` rides with it because
 * the two are only valid together — a `menuitemradio` with no state and a
 * `menuitem` with one are each invalid ARIA.
 */
function roleFor(checked: boolean | undefined): {
  role: Role;
  "aria-checked"?: boolean;
} {
  if (checked === undefined) return { role: "menuitem" };
  return { role: "menuitemradio" as Role, "aria-checked": checked };
}

export function Row({
  id,
  label,
  detail,
  value,
  accessibilityLabel,
  leading,
  touch,
  danger = false,
  shortcut,
  submenu = false,
  checked,
  disabled = false,
  align = "left",
  focused = false,
  onActivate,
  onHover,
  testID,
}: {
  id: string;
  label: string;
  /** A second line, for an outcome the verb cannot carry alone. */
  detail?: string;
  /** What the row is set to now, at its right. See `MenuItem.value`. */
  value?: string;
  /** The accessible name, where the visible label is not a whole one. */
  accessibilityLabel?: string;
  /** A mark before the label. Decorative — the accessible name is `label`. */
  leading?: ReactNode;
  touch: boolean;
  danger?: boolean;
  shortcut?: string;
  submenu?: boolean;
  /**
   * The setting in force, where "in force" is a question with an answer.
   *
   * `false` and `undefined` are different: `false` reserves the gutter so the
   * rows of one radio group line up under each other, `undefined` draws no
   * gutter at all. See `MenuItem.checked`.
   */
  checked?: boolean;
  /**
   * Present, drawn dimmed, and does not fire. See `MenuItem.disabled` for why
   * this exists at all when the file menu's rule is absence.
   */
  disabled?: boolean;
  align?: "left" | "center";
  focused?: boolean;
  onActivate: () => void;
  onHover?: () => void;
  /** `MenuItem.testID`, or the `menu-item-<id>` default. */
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  // A disabled row must not light up either: a hover highlight on something
  // that will not fire is the control promising a press it does not honour.
  const lit = (hovered || focused) && !disabled;

  return (
    <Pressable
      {...roleFor(checked)}
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID ?? `menu-item-${id}`}
      aria-disabled={disabled || undefined}
      onPress={disabled ? undefined : onActivate}
      onHoverIn={() => {
        setHovered(true);
        onHover?.();
      }}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.row,
        touch ? styles.rowTouch : styles.rowPointer,
        !touch && detail !== undefined && styles.rowPointerTall,
        align === "center" && styles.rowCentered,
        lit && (touch ? styles.rowHover : styles.rowLit),
        disabled && styles.rowOff,
      ]}
    >
      {leading}
      {/*
        The radio gutter. Present on every row of a group that has one, so the
        labels of the checked and unchecked rows start on the same vertical
        line — a check that shifts its own label right is a list that appears to
        re-order itself as you change the setting.
      */}
      {checked === undefined ? null : (
        <View style={styles.checkGutter} testID={`menu-check-${id}`}>
          {checked ? (
            <Icon
              name="check"
              size={touch ? 15 : 12}
              color={lit && !touch ? colors.ink : colors.text}
            />
          ) : null}
        </View>
      )}
      {/*
        One column, so a detail line stacks under its label instead of sitting
        beside it and pushing the chord and the chevron off the edge.
      */}
      <View style={styles.labelColumn} testID={`menu-labels-${id}`}>
        <Text
          variant={touch ? "body" : "tree"}
          numberOfLines={1}
          testID={`menu-label-${id}`}
          style={[styles.label, danger && styles.dangerLabel, lit && !touch && styles.labelLit]}
        >
          {label}
        </Text>
        {detail === undefined ? null : (
          <Text variant="treeMeta" numberOfLines={2} testID={`menu-detail-${id}`}>
            {detail}
          </Text>
        )}
      </View>
      {value === undefined ? null : (
        <Text variant="treeMeta" numberOfLines={1} style={styles.value} testID={`menu-value-${id}`}>
          {value}
        </Text>
      )}
      {touch || shortcut === undefined ? null : (
        <Text variant="treeMeta" style={styles.shortcut}>
          {shortcut}
        </Text>
      )}
      {!submenu ? null : (
        <Icon name="chevronRight" size={touch ? 16 : 13} color={colors.muted} />
      )}
    </Pressable>
  );
}

/** `separatorBefore` — a hairline with air around it, never a heavy rule. */
export function Separator({ touch }: { touch: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return <View aria-hidden style={[styles.separator, touch && styles.separatorTouch]} />;
}

export function ItemRow({
  item,
  touch,
  focused,
  onActivate,
  onHover,
}: {
  item: MenuItem<string>;
  touch: boolean;
  focused?: boolean;
  onActivate: () => void;
  onHover?: () => void;
}) {
  return (
    <Row
      id={item.id}
      label={item.label}
      detail={item.detail}
      value={item.value}
      leading={item.leading}
      touch={touch}
      danger={item.danger === true}
      shortcut={item.shortcut}
      submenu={item.items !== undefined}
      checked={item.checked}
      disabled={item.disabled === true}
      focused={focused}
      onActivate={onActivate}
      onHover={onHover}
      testID={item.testID}
    />
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /* --------------------------------- row --------------------------------- */

  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  rowPointer: {
    gap: space.x3,
    height: ROW_HEIGHT,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
  },
  rowTouch: {
    gap: space.x3,
    minHeight: TOUCH_ROW_MIN_HEIGHT,
    paddingVertical: space.x3,
    paddingHorizontal: space.x5,
    borderRadius: radii.md,
  },
  /**
   * A pointer row carrying a detail, at exactly the height `rowHeight` says it
   * is. Declared rather than left to `minHeight` because the popover's
   * placement arithmetic — `heightFor`, `offsetOfRow` — imposes these numbers,
   * and a row that grows past what was measured is a menu that runs off the
   * bottom of the window instead of flipping above the pointer.
   */
  rowPointerTall: { height: ROW_HEIGHT + DETAIL_BLOCK },
  rowCentered: { justifyContent: "center" },
  /** Hover and keyboard focus are the same visual state, on purpose: there is
   * one highlighted row at a time whichever device moved it. */
  rowLit: { backgroundColor: colors.accentDim },
  rowHover: { backgroundColor: colors.surface3 },
  label: { flexShrink: 1 },
  /**
   * The label and its detail, stacked.
   *
   * `flexShrink` and **not** `flex: 1`: the chord and the chevron already push
   * themselves to the end with `marginLeft: "auto"`, and a column that grows
   * would fill the row and leave `justifyContent: "center"` nothing to centre —
   * silently left-aligning the Cancel row, the one row here that is centred on
   * purpose.
   */
  labelColumn: { flexShrink: 1, gap: 2, justifyContent: "center" },
  labelLit: { color: colors.accentText },
  dangerLabel: { color: colors.critText },
  /**
   * The radio gutter. A fixed width, and `CHECK_BLOCK` is that width plus the
   * row's gap — the two are a pair, and the geometry above measures with it.
   */
  checkGutter: { width: 12, alignItems: "center", justifyContent: "center" },
  /** Present but unavailable. See `MenuItem.disabled`. */
  rowOff: { opacity: 0.4 },
  shortcut: { marginLeft: "auto" },
  /** `MenuItem.value`: pushed right, and the first thing to give way to a long label. */
  value: { marginLeft: "auto", flexShrink: 1, maxWidth: "50%", color: colors.muted, textAlign: "right" },
  chevron: { marginLeft: "auto" },
  separator: {
    height: 1,
    backgroundColor: colors.line,
    marginVertical: space.x1,
  },
  separatorTouch: { marginVertical: space.x2 },
});
