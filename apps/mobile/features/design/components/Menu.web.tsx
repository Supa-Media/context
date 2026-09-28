import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import type { MenuActionId, MenuItem } from "../../console/files/menu";
import { layout, radii } from "../tokens";
import { MARGIN, place, type Box } from "./popoverPlacement";
import { ROW_HEIGHT, PADDING, BORDER, widthFor, heightFor, offsetOfRow, fixedAt } from "./menuGeometry";
import { useThemedStyles, type Colors } from "../theme";
import { ItemRow, Separator } from "./MenuRow";
import { MenuSheet } from "./MenuSheet";

/**
 * The action menu — **the browser**, which is both a desktop and a phone.
 *
 * `features/console/files/menu.ts` decides *what* to offer; this file decides
 * what that looks like. `Menu.tsx` is the native sheet and is untouched by any
 * of this; see the comment at the top of it for why the two files exist, why
 * neither can import the other, and why `MenuProps` is therefore written out
 * twice.
 *
 * This file is the choice and the popover. The sheet is `MenuSheet.tsx`, and
 * the rows both presentations draw are `MenuRow.tsx`; neither is a platform
 * file, and only this one imports them.
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
 * `frame.ts`'s `densityFor` calls the same threshold `compact`, so the width at
 * which this file stops drawing a popover is the width at which the app stops
 * being a pointer layout. One threshold, named once.
 *
 * **The rest of that sentence has stopped being true and is corrected rather
 * than dropped.** It read "and `Explorer` passes `platform: "touch"` to
 * `menu.ts` at exactly that density. One breakpoint therefore decides both
 * halves of the same menu — which items exist, and how big they are drawn."
 * `Explorer.tsx` passes the literal `"web"` now: the file tree exists only on a
 * pointer layout (`frame.ts` answers `explorer: "hidden"` at compact), and
 * deriving the platform from a density with one possible value was the pretence
 * that a phone could reach that tree. So nothing in this app asks `menu.ts` for
 * its `touch` arm, and that arm is on `frame.ts`'s deliberately-kept list with
 * its own reason. The day something does pass it, this is the threshold it
 * should read — which is why the breakpoint stays named rather than becoming a
 * number.
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
export interface MenuProps<Id extends string = MenuActionId> {
  items: MenuItem<Id>[];
  /** Where the pointer was. Web anchors a popover here; touch ignores it. */
  anchor?: { x: number; y: number };
  /** Sheet heading on touch — the file name. Web shows no heading. */
  title?: string;
  /**
   * A second line under `title` — the account menu's email under the
   * signed-in name. Sheet only, same as `title`: the popover shows neither.
   */
  titleDetail?: string;
  /**
   * What the sheet draws instead of `items`, and above them — sheet only, the
   * popover keeps `items`. A task's menu on a phone lifts its Priority page
   * into a row of chips here (`folderPage/tasks/phoneSheet.ts`); the ids are
   * the same, so both presentations dispatch through the one `onSelect`.
   * Written out identically in `Menu.tsx`.
   */
  sheet?: { items: MenuItem<Id>[]; header?: ReactNode };
  onSelect: (id: Id) => void;
  onDismiss: () => void;
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
  items: readonly MenuItem<string>[];
  box: Box;
  focus: number;
  nodeRef: (node: unknown) => void;
  onActivate: (item: MenuItem<string>, index: number) => void;
  onHover: (item: MenuItem<string>, index: number) => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
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

function Popover<Id extends string = MenuActionId>({
  items,
  anchor,
  onSelect,
  onDismiss,
}: MenuProps<Id>) {
  const view = useWindowDimensions();
  const rootNode = useRef<HTMLElement | null>(null);
  const subNode = useRef<HTMLElement | null>(null);

  /** The submenu's parent, by id, and whether the keyboard is inside it. */
  const [openId, setOpenId] = useState<Id | null>(null);
  const [inSub, setInSub] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [subFocus, setSubFocus] = useState(-1);

  const openIndex = items.findIndex((item) => item.id === openId && item.items !== undefined);
  const parent = openIndex === -1 ? null : items[openIndex];
  const children = parent?.items ?? [];

  const root = place(
    anchor?.x ?? MARGIN,
    anchor?.y ?? MARGIN,
    { width: widthFor(items), height: heightFor(items) },
    view,
    { minHeight: ROW_HEIGHT },
  );

  const sub =
    parent === null
      ? null
      : place(
          root.left + root.width,
          root.top + offsetOfRow(items, openIndex) - PADDING,
          { width: widthFor(children), height: heightFor(children) },
          view,
          { across: root.width, minHeight: ROW_HEIGHT },
        );

  const close = (id: Id) => {
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
          /*
            A disabled row refuses the keyboard exactly as it refuses a click.

            The pointer path drops `onPress`, which is invisible from here — so
            without this check a row that was dimmed, inert to a click and
            marked `aria-disabled` fired anyway for anybody driving the menu
            from the keyboard. That is the one group most likely to be reading
            the `aria-disabled` that promised it would not.

            Arrows still land on it, deliberately: `aria-disabled` means "here
            and unavailable", and skipping it would hide from a screen-reader
            user a row everybody else can see.
          */
          if (item.disabled === true) return;
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

  /*
    `document.body`, not the DOM this component would otherwise mount into —
    `docs/decisions/app-and-console.md`'s "every react-native-web `View` is a
    stacking context" applies to this box exactly as it does to the rail's own
    context menu: `position: fixed` and `zIndex: 1000` only order this popover
    among the *descendants* of whichever `View` it happens to render inside,
    because that `View` carries RNW's base `position: relative; z-index: 0`
    like every other one. `AccountMenuTrigger` is the case that found it —
    the trigger sits at the foot of the rail, an *earlier* sibling of the
    editor region in `AppFrame.tsx`'s tree, so a later sibling with its own
    content at that point on screen painted over the box and ate its clicks,
    silently, measured live as a Chromium e2e timeout rather than anything a
    jsdom suite could see. `Modal` (the sheet's own presentation, just below)
    never had this problem — `react-native-web`'s implementation already
    portals to `document.body` for exactly this reason — so this is the
    popover catching up to what the sheet already had for free, not a new
    idea. `Sheet` above stays where it renders; only this presentation needed
    it, because only this one skips `Modal`.
  */
  return createPortal(
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
          /*
            `item` is `MenuItem<string>` here — `Panel` is a dumb renderer
            with no reason to know this menu's own id union — but it is the
            same object `items` (this closure's `MenuItem<Id>[]`) handed it,
            so the id genuinely is an `Id`. The cast says only that; it adds
            no behaviour `Panel`'s own typing does not already guarantee.
          */
          const id = item.id as Id;
          if (item.items !== undefined) {
            setOpenId(openId === id ? null : id);
            setInSub(false);
            setFocus(index);
            return;
          }
          close(id);
        }}
        onHover={(item, index) => {
          setFocus(index);
          setInSub(false);
          setSubFocus(-1);
          // Hovering a row with no submenu closes whatever was open, so the
          // pointer never leaves a stray panel beside a different row.
          setOpenId(item.items === undefined ? null : (item.id as Id));
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
          onActivate={(item) => close(item.id as Id)}
          onHover={(_item, index) => {
            setInSub(true);
            setSubFocus(index);
          }}
        />
      )}
    </>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */

export function Menu<Id extends string = MenuActionId>(props: MenuProps<Id>) {
  const { width } = useWindowDimensions();

  /**
   * The room decides, not the device — see the header. Two components rather
   * than one with branches inside it, so switching presentations remounts
   * instead of carrying a popover's keyboard state into a sheet that has no
   * keyboard.
   */
  return width < layout.narrowBreakpoint ? <MenuSheet {...props} /> : <Popover {...props} />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
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
});
