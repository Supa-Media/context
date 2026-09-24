import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Platform, View } from "react-native";
import { layout } from "../../design/tokens";
import { useThemedStyles } from "../../design/theme";
import { makeStyles } from "./styles";

/**
 * Hold the document still for the length of a drag, and hand it back.
 *
 * **A pointer moving with the button down is a text selection, as far as a
 * browser is concerned, and that is what used to kill this gesture.**
 * react-native-web's responder system listens for `selectionchange` on the
 * document and terminates the current responder the moment the selection
 * becomes a real one — a non-empty string with a text node at either end
 * (`isSelectionValid`) — asking `onResponderTerminationRequest` first, which
 * defaults to yes. Mid-drag that is `onPanResponderTerminate`: the gesture
 * ends, and nothing says so except the column stopping under the pointer.
 *
 * It read as a one-directional handle. Dragging the seam **left** puts the
 * pointer over the tree's note names as soon as it gets ahead of the column,
 * so the browser starts selecting and the drag dies a few pixels in; dragging
 * **right** puts it over CodeMirror's editing host, where a selection begun
 * outside does not extend, so that direction never hit it. What was left
 * worked only when it was moved slowly enough to stay inside the 7pt handle,
 * which is the one strip on that side with no text in it.
 *
 * Refusing the termination request is what keeps the gesture (see the
 * responder below). This is what keeps the page from painting a selection
 * across the tree underneath it, and keeps the resize cursor on the pointer
 * once it is past the handle. Returning the restore rather than a second
 * exported function keeps the pair impossible to mismatch.
 */
function holdDocumentStill(): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const { style } = document.body;
  /*
    Set through `setProperty` and in both spellings, because **Safari's CSSOM
    has no `userSelect` property at all**: `style.userSelect = "none"` is a
    silent no-op there, leaving the page as selectable as it was, and reading it
    back answers `undefined` rather than anything a test would notice. The
    WebKit run of `panels.spec.ts` is what says so, which is what that suite is
    for.
  */
  const held = [
    ["user-select", "none"],
    ["-webkit-user-select", "none"],
    ["cursor", "col-resize"],
  ] as const;
  const previous = held.map(([name]) => [name, style.getPropertyValue(name)] as const);
  for (const [name, value] of held) style.setProperty(name, value);
  /*
    Nothing clears an existing selection here, and the absence is deliberate:
    the browser collapses one on the press by itself — measured in Chromium, on
    a page that turns `user-select` off in the same handler this one does — and
    a `removeAllRanges` for the engines where that might not hold would be a
    line no test in this repository can fail on. What the gesture actually needs
    from the selection is below, where it refuses to be terminated by one.
  */
  return () => {
    for (const [name, value] of previous) {
      if (value === "") style.removeProperty(name);
      else style.setProperty(name, value);
    }
  };
}

/**
 * The explorer's drag handle.
 *
 * `PanResponder` rather than web pointer events, because it is the one gesture
 * API that behaves identically under RN-Web and on a device — a tablet in a
 * split view resizes this the same way a mouse does. The width is clamped in
 * `frame.ts`, so a drag can neither hide the region nor squeeze the editor
 * below a readable measure.
 */
export function ExplorerResizer({
  width,
  onResize,
  onClose,
}: {
  width: number;
  onResize: (next: number) => void;
  /** Called on release, when the drag went far enough past the floor. */
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [active, setActive] = useState(false);
  /**
   * Whether releasing now would fold the column away.
   *
   * **The clamp is not weakened by this and that is the whole of the design.**
   * `clampExplorerWidth` still refuses to render anything below the floor,
   * because the floor is where a kebab-case name under two indents stops being
   * readable. What it used to do past that point was simply refuse, and its
   * comment gave the reason: dragging to zero is how somebody hides a region
   * and then wonders where it went. That reason is answered now by the seam
   * that stays behind, so the drag can mean something past the floor instead of
   * meeting a wall — it arms, it says so, and releasing above the floor snaps
   * back.
   */
  const [arming, setArming] = useState(false);
  const armed = useRef(false);

  /**
   * The live width, and the width this drag started from.
   *
   * `liveWidth` is a ref rather than the `width` prop read straight out of the
   * closure below, and that is the whole point of this component's shape.
   *
   * **Do not add `width` to the responder's dependency list.** Putting the
   * value a memo closes over into its deps is the correct instinct almost
   * everywhere and is a bug here, because `width` is the value
   * `onPanResponderMove` itself changes: listing it rebuilds the responder on
   * every move event of a drag. `onPanResponderGrant` does *not* run again —
   * the gesture is already granted — but react-native-web's `PanResponder`
   * gives each instance a fresh `gestureState` with `dx: 0`, so every move
   * applies only the increment since the last rebuild while `startWidth` still
   * holds the grant-time width. A 150px drag from 260 then lands on 360
   * instead of 410, in stuttering jumps.
   *
   * So the responder depends on nothing a drag can change, and the one value
   * it needs at grant time arrives through a ref that a commit keeps current.
   */
  const liveWidth = useRef(width);
  useEffect(() => {
    liveWidth.current = width;
  }, [width]);
  const startWidth = useRef(width);
  /*
    `onClose` goes through a ref for the reason above, which applies to it more
    sharply than to `onResize`. `setExplorerWidth` is stable; `toggleExplorer`
    is not — it closes over the window width — so listing it here would rebuild
    the responder on any resize, and the paragraph above is about what a rebuild
    mid-gesture costs. The deps stay "nothing a drag can change", which is the
    invariant, rather than "nothing a drag happens to change today".
  */
  const liveClose = useRef(onClose);
  useEffect(() => {
    liveClose.current = onClose;
  }, [onClose]);

  /**
   * What `holdDocumentStill` handed back, for as long as the drag runs.
   *
   * Cleared by the release and by a terminate, and those two are the whole of
   * it — including the case that looks like it needs a third. The column can
   * go away mid-gesture (⌘⇧E, or a window narrowed out of this density), and
   * react-native-web's `removeNode` terminates the responder it is unmounting,
   * so the terminate arm covers an unmount as well; an effect cleanup beside it
   * would be a guard that never runs, and `appFrameRender` holds the claim
   * instead. It matters that something does: a page left unselectable with a
   * resize cursor on it is a worse bug than the one this fixes, and the only
   * way back from it is a reload.
   */
  const releaseDocument = useRef<(() => void) | null>(null);
  const endHold = useCallback(() => {
    releaseDocument.current?.();
    releaseDocument.current = null;
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startWidth.current = liveWidth.current;
          releaseDocument.current = holdDocumentStill();
          setActive(true);
        },
        onPanResponderMove: (_event, gesture) => {
          const raw = startWidth.current + gesture.dx;
          /*
            The *raw* width decides whether the close is armed, and the clamped
            one is what gets rendered. Reading the clamped value here would make
            this unreachable: it can never be below the floor, so the drag would
            arm at exactly the moment it stopped being able to.
          */
          const next = raw < layout.explorerMinWidth - layout.explorerCloseOvershoot;
          if (next !== armed.current) {
            armed.current = next;
            setArming(next);
          }
          onResize(raw);
        },
        /*
          **A drag on this handle is not up for negotiation, and that is the
          fix.** The default answer is yes, which hands the gesture to whatever
          asks — and on the web the thing that asks is the browser's own text
          selection, every time the pointer crosses a note's name on its way
          left. See `holdDocumentStill` above for what that looked like.

          It costs nothing a resize wants: `selectionchange`, `scroll` and
          `contextmenu` are the only events routed through this request, and
          none of them should end a drag somebody is in the middle of. A real
          cancel — `dragstart`, a lost touch — does not ask, and still
          terminates below.
        */
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: () => {
          endHold();
          setActive(false);
          if (armed.current) liveClose.current();
          armed.current = false;
          setArming(false);
        },
        /*
          A terminated gesture is not a release. The pointer was taken away by
          something else — a browser drag, a lost capture — and folding a panel
          on the strength of that is the surprise this whole design is trying
          not to be, so it only disarms.
        */
        onPanResponderTerminate: () => {
          endHold();
          setActive(false);
          armed.current = false;
          setArming(false);
        },
      }),
    [endHold, onResize],
  );

  return (
    <View
      {...responder.panHandlers}
      style={[
        styles.resizer,
        { left: width - layout.explorerSeamOverhang },
        active && styles.resizerActive,
        arming && styles.resizerArming,
      ]}
      accessibilityLabel="Resize the file tree"
      role="separator"
      testID="explorer-resizer"
    >
      {/*
        A marker, not a button, and that is the one real constraint this seam
        has. A press target in the middle of a drag handle takes the most
        natural place to grab a divider and makes it do something else — so the
        seam behind a resizable panel drags, the seam behind a folded or
        fixed-width one is pressed, and the status bar carries the toggle that
        works the same way for both. What this draws is the answer to "what will
        releasing do", which only a drag can ask.
      */}
      {arming ? <View style={styles.seamArmMark} testID="explorer-seam-arming" /> : null}
    </View>
  );
}

/**
 * The right panel's drag handle.
 *
 * **A smaller component than `ExplorerResizer`, on purpose.** That one carries
 * a whole second behaviour — dragging past the floor *arms a close*, with its
 * own state, its own marker and a paragraph explaining why the clamp is not
 * weakened by it. The panel does not need it: the tree's seam exists because
 * folding the tree leaves a 10pt strip somebody has to find again, whereas
 * this panel's toggle is a labelled button in the top bar that is there
 * whether it is open or shut. A drag that could close it would be a second way
 * to do something the first way already does well, with a state machine
 * attached.
 *
 * What it does share is the two things that are about *dragging* rather than
 * about the tree: `holdDocumentStill`, because on the web the browser's own
 * text selection grabs the gesture the moment the pointer crosses a word; and
 * the refs-not-deps rule, whose reasoning is written out at length on
 * `ExplorerResizer` and is exactly as true here.
 */
export function AsideResizer({
  width,
  onResize,
}: {
  width: number;
  onResize: (next: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [active, setActive] = useState(false);

  const liveWidth = useRef(width);
  useEffect(() => {
    liveWidth.current = width;
  }, [width]);
  const startWidth = useRef(width);

  const releaseDocument = useRef<(() => void) | null>(null);
  const endHold = useCallback(() => {
    releaseDocument.current?.();
    releaseDocument.current = null;
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startWidth.current = liveWidth.current;
          releaseDocument.current = holdDocumentStill();
          setActive(true);
        },
        /*
          **Minus `dx`, where the tree's is plus.** This column is pinned to
          the trailing edge, so dragging left makes it wider. Getting this
          backwards is the kind of thing that reads fine and feels broken, so
          it is a sign rather than a comment.
        */
        onPanResponderMove: (_event, gesture) => onResize(startWidth.current - gesture.dx),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: () => {
          endHold();
          setActive(false);
        },
        onPanResponderTerminate: () => {
          endHold();
          setActive(false);
        },
      }),
    [endHold, onResize],
  );

  return (
    <View
      {...responder.panHandlers}
      style={[
        styles.asideResizer,
        // Placed from the right, because the column is. `right` is the
        // column's own width less the overhang, so the strip straddles the
        // border it is drawn on — the mirror of `resizer`'s `left`.
        { right: width - layout.explorerSeamOverhang },
        active && styles.asideResizerActive,
      ]}
      accessibilityLabel="Resize the chat panel"
      role="separator"
      testID="aside-resizer"
    />
  );
}
