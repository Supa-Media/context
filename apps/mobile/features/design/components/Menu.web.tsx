import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import type { MenuActionId, MenuItem } from "../../console/files/menu";
import { colors, radii, space } from "../tokens";
import { Text } from "./Text";

/**
 * The action menu — **pointer**.
 *
 * The touch sheet lives in `Menu.tsx`; this is the same list of items as a
 * context-menu popover, and the two are separate files rather than one
 * component with a branch because they are two different interactions. See the
 * comment at the top of `Menu.tsx` for the split, including why neither file
 * can import the other and why `MenuProps` is therefore written out twice.
 *
 * ## The geometry is a model, not a measurement
 *
 * Every dimension this file positions with is one it also *imposes*:
 * `ROW_HEIGHT` is the row's `height`, `SEPARATOR_BLOCK` is the rule plus its
 * margins, `PADDING` and `BORDER` are the box's own. The width is chosen here
 * and set explicitly rather than left to the content. So the size used to
 * decide placement is the size the browser will use, with no measure pass, no
 * `ResizeObserver`, and no first frame drawn in the wrong place and corrected.
 *
 * That matters because of what it buys:
 *
 * **A menu opened near an edge must flip, not clip.** Right-clicking the last
 * row of the tree, or a row near the right edge of the window, is not an edge
 * case — it is where the interesting rows are. A popover that renders down-right
 * unconditionally puts "Delete forever…" underneath the bottom of the window
 * where no amount of scrolling reaches it, because the popover is `fixed` and
 * the page behind it does not scroll it into view. That single bug is most of
 * what makes a context menu feel broken, and it is invisible to anyone testing
 * in the middle of a large screen.
 *
 * The same rule applies again, independently, to a submenu: it opens to the
 * right of its parent and flips to the left when the right has no room.
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

/* -------------------------------------------------------------------------- */
/*                                  geometry                                  */
/* -------------------------------------------------------------------------- */

/** Compact: this is a pointer target, and 44pt rows would make it a list. */
const ROW_HEIGHT = 28;
/** The hairline plus the air above and below it. */
const SEPARATOR_BLOCK = 1 + space.x1 * 2;
const PADDING = 6;
const BORDER = 1;
/** Never closer to the edge of the window than this. */
const MARGIN = 8;

const MIN_WIDTH = 200;
const MAX_WIDTH = 340;
/**
 * Roughly the advance width of the 13px UI face, used to size the box to its
 * longest row. An estimate, and the only one here — but it decides the box's
 * declared `width`, so whatever it estimates is what the browser then lays out.
 * Placement stays exact even when the guess is generous.
 */
const CHAR_WIDTH = 7;
const ROW_CHROME = 34;

function widthFor(items: readonly MenuItem[]): number {
  let widest = MIN_WIDTH;
  for (const item of items) {
    const chord = item.shortcut === undefined ? 0 : item.shortcut.length + 3;
    const chevron = item.items === undefined ? 0 : 2;
    widest = Math.max(widest, (item.label.length + chord + chevron) * CHAR_WIDTH + ROW_CHROME);
  }
  return Math.min(MAX_WIDTH, Math.round(widest));
}

function heightFor(items: readonly MenuItem[]): number {
  const rules = items.filter((item) => item.separatorBefore === true).length;
  return PADDING * 2 + BORDER * 2 + items.length * ROW_HEIGHT + rules * SEPARATOR_BLOCK;
}

/** How far below the top of the box a given row's own top edge sits. */
function offsetOfRow(items: readonly MenuItem[], index: number): number {
  let offset = PADDING + BORDER;
  for (let at = 0; at < index; at += 1) {
    if (items[at].separatorBefore === true) offset += SEPARATOR_BLOCK;
    offset += ROW_HEIGHT;
  }
  if (items[index]?.separatorBefore === true) offset += SEPARATOR_BLOCK;
  return offset;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Viewport {
  width: number;
  height: number;
}

/**
 * Place a box of `size` at `x, y`, flipping rather than clipping.
 *
 * `preferLeft` / `preferAbove` are for a submenu, which does not start at the
 * pointer: its natural place is *beside* its parent, so when it flips it must
 * flip back across the parent's whole width rather than across a point. The
 * caller passes that width as `across`.
 */
function place(
  x: number,
  y: number,
  size: { width: number; height: number },
  view: Viewport,
  across = 0,
): Box {
  const height = Math.min(size.height, Math.max(ROW_HEIGHT, view.height - MARGIN * 2));

  let left = x;
  if (left + size.width > view.width - MARGIN) left = x - size.width - across;
  // A window narrower than the menu has no side that fits; sit against the
  // left edge rather than off either one.
  if (left < MARGIN) left = Math.max(MARGIN, Math.min(x, view.width - MARGIN - size.width));

  let top = y;
  if (top + height > view.height - MARGIN) top = y - height;
  if (top < MARGIN) top = MARGIN;

  return { left, top, width: size.width, height };
}

/** `position: fixed` is web-only and absent from React Native's style type. */
function fixedAt(box: Box): ViewStyle {
  return {
    position: "fixed",
    left: box.left,
    top: box.top,
    width: box.width,
    maxHeight: box.height,
  } as unknown as ViewStyle;
}

/* -------------------------------------------------------------------------- */
/*                                    rows                                    */
/* -------------------------------------------------------------------------- */

function Row({
  item,
  focused,
  onActivate,
  onHover,
}: {
  item: MenuItem;
  focused: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const lit = hovered || focused;

  return (
    <Pressable
      role="menuitem"
      accessibilityLabel={item.label}
      testID={`menu-item-${item.id}`}
      onPress={onActivate}
      onHoverIn={() => {
        setHovered(true);
        onHover();
      }}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, lit && styles.rowLit]}
    >
      <Text
        variant="tree"
        numberOfLines={1}
        testID={`menu-label-${item.id}`}
        style={[styles.label, item.danger === true && styles.dangerLabel, lit && styles.labelLit]}
      >
        {item.label}
      </Text>
      {item.shortcut === undefined ? null : (
        <Text variant="treeMeta" style={styles.shortcut}>
          {item.shortcut}
        </Text>
      )}
      {item.items === undefined ? null : (
        <Text variant="treeMeta" aria-hidden style={styles.chevron}>
          ›
        </Text>
      )}
    </Pressable>
  );
}

function Panel({
  items,
  box,
  focus,
  nodeRef,
  onActivate,
  onHover,
  testID,
}: {
  items: readonly MenuItem[];
  box: Box;
  focus: number;
  nodeRef: (node: unknown) => void;
  onActivate: (item: MenuItem, index: number) => void;
  onHover: (item: MenuItem, index: number) => void;
  testID: string;
}) {
  return (
    <View ref={nodeRef} role="menu" testID={testID} style={[styles.panel, fixedAt(box)]}>
      {items.map((item, index) => (
        <View key={item.id}>
          {item.separatorBefore === true ? <View aria-hidden style={styles.separator} /> : null}
          <Row
            item={item}
            focused={focus === index}
            onActivate={() => onActivate(item, index)}
            onHover={() => onHover(item, index)}
          />
        </View>
      ))}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

export function Menu({ items, anchor, onSelect, onDismiss }: MenuProps) {
  const view = useWindowDimensions();
  const rootNode = useRef<HTMLElement | null>(null);
  const subNode = useRef<HTMLElement | null>(null);

  /** The submenu's parent, by id, and whether the keyboard is inside it. */
  const [openId, setOpenId] = useState<MenuActionId | null>(null);
  const [inSub, setInSub] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [subFocus, setSubFocus] = useState(-1);

  const openIndex = items.findIndex((item) => item.id === openId && item.items !== undefined);
  const parent = openIndex === -1 ? null : items[openIndex];
  const children = parent?.items ?? [];

  const root = place(anchor?.x ?? MARGIN, anchor?.y ?? MARGIN, {
    width: widthFor(items),
    height: heightFor(items),
  }, view);

  const sub =
    parent === null
      ? null
      : place(
          root.left + root.width,
          root.top + offsetOfRow(items, openIndex) - PADDING,
          { width: widthFor(children), height: heightFor(children) },
          view,
          root.width,
        );

  const close = (id: MenuActionId) => {
    onSelect(id);
    onDismiss();
  };

  /**
   * Everything that means "you are no longer pointing at this menu".
   *
   * A context menu is anchored to a point in a document that can move under it.
   * Scroll is therefore a dismissal, not something to re-anchor against: a
   * `fixed` popover left hanging over a scrolled page points at whatever
   * happens to be under it now, which is how a menu ends up acting on the wrong
   * file. Listening in the capture phase catches scrolling inside the tree,
   * which never reaches `window`.
   */
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null && rootNode.current?.contains(target) === true) return;
      if (target !== null && subNode.current?.contains(target) === true) return;
      onDismiss();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("scroll", onDismiss, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onDismiss]);

  /**
   * The menu owns the keyboard while it is open.
   *
   * `keymap.ts` says an overlay does, and says so for a reason worth repeating
   * here: ⌘N while this is open must not create a note behind it. These five
   * keys are handled locally rather than through `resolve` because two of them
   * — ← and → — are bound to the *tree's* collapse and expand, and inside this
   * overlay they mean "leave this submenu" and "enter it". Every one of them is
   * consumed with `preventDefault`, so nothing behind the menu sees it.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const list = inSub ? children : items;
      const at = inSub ? subFocus : focus;
      const move = (next: number) => {
        if (list.length === 0) return;
        const wrapped = (next + list.length) % list.length;
        if (inSub) setSubFocus(wrapped);
        else setFocus(wrapped);
      };

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onDismiss();
          return;
        case "ArrowDown":
          event.preventDefault();
          move(at + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          move(at === -1 ? list.length - 1 : at - 1);
          return;
        case "ArrowRight": {
          event.preventDefault();
          const item = list[at];
          if (inSub || item?.items === undefined) return;
          setOpenId(item.id);
          setInSub(true);
          setSubFocus(0);
          return;
        }
        case "ArrowLeft":
          event.preventDefault();
          if (!inSub) return;
          setInSub(false);
          setSubFocus(-1);
          setOpenId(null);
          return;
        case "Enter": {
          event.preventDefault();
          const item = list[at];
          if (item === undefined) return;
          // A parent is never dispatched — `menu.ts` gives it an id with no
          // handler precisely so a slip here is a no-op rather than a privacy
          // change, and this is the check that keeps it from being either.
          if (item.items !== undefined) {
            setOpenId(item.id);
            setInSub(true);
            setSubFocus(0);
            return;
          }
          close(item.id);
          return;
        }
        default:
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <>
      <Panel
        items={items}
        box={root}
        focus={inSub ? -1 : focus}
        nodeRef={(node) => {
          rootNode.current = node as HTMLElement | null;
        }}
        testID="menu-root"
        onActivate={(item, index) => {
          if (item.items !== undefined) {
            setOpenId(openId === item.id ? null : item.id);
            setInSub(false);
            setFocus(index);
            return;
          }
          close(item.id);
        }}
        onHover={(item, index) => {
          setFocus(index);
          setInSub(false);
          setSubFocus(-1);
          // Hovering a row with no submenu closes whatever was open, so the
          // pointer never leaves a stray panel beside a different row.
          setOpenId(item.items === undefined ? null : item.id);
        }}
      />
      {parent === null || sub === null ? null : (
        <Panel
          items={children}
          box={sub}
          focus={subFocus}
          nodeRef={(node) => {
            subNode.current = node as HTMLElement | null;
          }}
          testID="menu-sub"
          onActivate={(item) => close(item.id)}
          onHover={(_item, index) => {
            setInSub(true);
            setSubFocus(index);
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingVertical: PADDING,
    borderWidth: BORDER,
    borderColor: colors.lineStrong,
    borderRadius: radii.xl,
    backgroundColor: colors.surface3,
    boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)",
    overflow: "hidden",
    zIndex: 1000,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x3,
    height: ROW_HEIGHT,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
  },
  /** Hover and keyboard focus are the same visual state, on purpose: there is
   * one highlighted row at a time whichever device moved it. */
  rowLit: { backgroundColor: colors.accentDim },
  label: { flexShrink: 1 },
  labelLit: { color: colors.accentText },
  dangerLabel: { color: colors.critText },
  shortcut: { marginLeft: "auto" },
  chevron: { marginLeft: "auto" },
  separator: {
    height: 1,
    backgroundColor: colors.line,
    marginVertical: space.x1,
  },
});
