import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuActionId, MenuItem } from "../../console/files/menu";
import { colors, layout, radii, space } from "../tokens";
import { Text } from "./Text";

/**
 * The action menu — **the browser**, which is both a desktop and a phone.
 *
 * `features/console/files/menu.ts` decides *what* to offer; this file decides
 * what that looks like. `Menu.tsx` is the native sheet and is untouched by any
 * of this; see the comment at the top of it for why the two files exist, why
 * neither can import the other, and why `MenuProps` is therefore written out
 * twice.
 *
 * ## Why the web half has to render both presentations
 *
 * The platform split alone gets this wrong, and it got it wrong here for the
 * whole of this branch. `./Menu` under web resolution is *always* this file, so
 * `Menu.tsx`'s 44pt sheet is reachable only from a native build — and this
 * product ships to phones as a web build. A phone browser long-press raises
 * `contextmenu` (see `rowInteractions.web.ts`), the gesture arrived correctly,
 * and what it opened was the 28px pointer popover: exactly the mis-tap next to
 * "Delete forever…" that `Menu.tsx` was written to avoid.
 *
 * So the *device* question is not answered by the file extension. The file
 * extension answers "is this a browser"; the window answers "is this a thumb".
 *
 * ## One rule, the same one `Palette.tsx` uses
 *
 * `Palette` picks its presentation with
 * `Platform.OS !== "web" || width < layout.narrowBreakpoint`. This file is the
 * same rule with its first term already decided: it only ever runs on web —
 * native resolves to `Menu.tsx`, which is the sheet unconditionally — so what
 * is left to ask is the width.
 *
 * `layout.narrowBreakpoint` and not a number, and not a *different* number:
 * `frame.ts`'s `densityFor` calls the same threshold `compact`, and `Explorer`
 * passes `platform: "touch"` to `menu.ts` at exactly that density. One
 * breakpoint therefore decides both halves of the same menu — which items
 * exist, and how big they are drawn — so there is no window width where the
 * items say "phone" and the chrome says "desktop".
 *
 * A desktop window dragged narrow gets the sheet, which is right for the same
 * reason it is right in `Palette`: the constraint is the room, not the device.
 *
 * ## The row is shared, the chrome is not
 *
 * There is exactly one `Row` here, taking a `touch` flag that changes its
 * density and nothing else — the same shape as `Palette`'s single
 * `PaletteRow`. Two row components would drift, and the drift would be silent:
 * a danger colour that stopped rendering on one presentation looks like a
 * design choice rather than a bug.
 *
 * What is genuinely different is the chrome around it, and it is different in
 * the ways `Menu.tsx` sets out: a submenu **pushes a page** rather than hanging
 * a second popover off the side of the first (a phone has nowhere to hang one
 * and no hover to open it), and there is a **Cancel** row (a scrim tap is not
 * discoverable, and the last item is destructive).
 *
 * ## The pointer geometry is a model, not a measurement
 *
 * Every dimension the popover positions with is one it also *imposes*:
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
/**
 * The thumb target, and the floor rather than the aim: the padding takes an
 * ordinary single-line row past it, and this keeps a short label honest.
 */
const TOUCH_ROW_MIN_HEIGHT = 44;
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
function Row({
  id,
  label,
  touch,
  danger = false,
  shortcut,
  submenu = false,
  align = "left",
  focused = false,
  onActivate,
  onHover,
}: {
  id: string;
  label: string;
  touch: boolean;
  danger?: boolean;
  shortcut?: string;
  submenu?: boolean;
  align?: "left" | "center";
  focused?: boolean;
  onActivate: () => void;
  onHover?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const lit = hovered || focused;

  return (
    <Pressable
      role="menuitem"
      accessibilityLabel={label}
      testID={`menu-item-${id}`}
      onPress={onActivate}
      onHoverIn={() => {
        setHovered(true);
        onHover?.();
      }}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.row,
        touch ? styles.rowTouch : styles.rowPointer,
        align === "center" && styles.rowCentered,
        lit && (touch ? styles.rowHover : styles.rowLit),
      ]}
    >
      <Text
        variant={touch ? "body" : "tree"}
        numberOfLines={1}
        testID={`menu-label-${id}`}
        style={[styles.label, danger && styles.dangerLabel, lit && !touch && styles.labelLit]}
      >
        {label}
      </Text>
      {touch || shortcut === undefined ? null : (
        <Text variant="treeMeta" style={styles.shortcut}>
          {shortcut}
        </Text>
      )}
      {!submenu ? null : (
        <Text variant={touch ? "tree" : "treeMeta"} aria-hidden style={styles.chevron}>
          ›
        </Text>
      )}
    </Pressable>
  );
}

/** `separatorBefore` — a hairline with air around it, never a heavy rule. */
function Separator({ touch }: { touch: boolean }) {
  return <View aria-hidden style={[styles.separator, touch && styles.separatorTouch]} />;
}

function ItemRow({
  item,
  touch,
  focused,
  onActivate,
  onHover,
}: {
  item: MenuItem;
  touch: boolean;
  focused?: boolean;
  onActivate: () => void;
  onHover?: () => void;
}) {
  return (
    <Row
      id={item.id}
      label={item.label}
      touch={touch}
      danger={item.danger === true}
      shortcut={item.shortcut}
      submenu={item.items !== undefined}
      focused={focused}
      onActivate={onActivate}
      onHover={onHover}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the sheet                                 */
/* -------------------------------------------------------------------------- */

function Sheet({ items, title, onSelect, onDismiss }: MenuProps) {
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
              <Row id="back" label={`‹  ${parent.label}`} touch onActivate={() => setOpenId(null)} />
              <Separator touch />
            </>
          )}

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

/* -------------------------------------------------------------------------- */
/*                                 the popover                                */
/* -------------------------------------------------------------------------- */

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
          {item.separatorBefore === true ? <Separator touch={false} /> : null}
          <ItemRow
            item={item}
            touch={false}
            focused={focus === index}
            onActivate={() => onActivate(item, index)}
            onHover={() => onHover(item, index)}
          />
        </View>
      ))}
    </View>
  );
}

function Popover({ items, anchor, onSelect, onDismiss }: MenuProps) {
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

/* -------------------------------------------------------------------------- */

export function Menu(props: MenuProps) {
  const { width } = useWindowDimensions();

  /**
   * The room decides, not the device — see the header. Two components rather
   * than one with branches inside it, so switching presentations remounts
   * instead of carrying a popover's keyboard state into a sheet that has no
   * keyboard.
   */
  return width < layout.narrowBreakpoint ? <Sheet {...props} /> : <Popover {...props} />;
}

const styles = StyleSheet.create({
  /* ------------------------------- popover ------------------------------- */

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

  /* -------------------------------- sheet -------------------------------- */

  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: radii.console,
    borderTopRightRadius: radii.console,
    borderTopWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
    paddingTop: space.x2,
    // A sheet that grows past this stops looking like a sheet and starts
    // looking like a screen you cannot leave; the list scrolls instead.
    maxHeight: "80%",
    boxShadow: "0 -30px 80px -30px rgba(0,0,0,1)",
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
  rowCentered: { justifyContent: "center" },
  /** Hover and keyboard focus are the same visual state, on purpose: there is
   * one highlighted row at a time whichever device moved it. */
  rowLit: { backgroundColor: colors.accentDim },
  rowHover: { backgroundColor: colors.surface3 },
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
  separatorTouch: { marginVertical: space.x2 },
});
