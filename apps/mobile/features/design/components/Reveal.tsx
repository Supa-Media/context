import { useEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { AccessibilityInfo, LayoutAnimation, Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { motion } from "../tokens/motion";

/**
 * Something that appears in the flow of a page, easing open and shut instead
 * of arriving in one frame.
 *
 * A row that mounts inside a column pushes everything under it down by its
 * full height at once. When the row arrives on its own — somebody joining the
 * note, a notice, an agent starting work — the reader sees the paragraph they
 * were reading leap away. This grows the room for it over `motion.layoutMs`
 * and fades the content in as it does, and runs the same thing backwards when
 * it leaves.
 *
 * **Leaving keeps the last content on screen.** A caller writes
 * `<Reveal open={cond}>{cond ? <X/> : null}</Reveal>` without thinking about
 * exits: the children it last rendered while open stay drawn while the space
 * closes, and only then is the subtree unmounted. When closed there is no
 * element at all, so a closed Reveal costs its parent nothing — no gap, no
 * zero-height child in a `gap:` column.
 *
 * **Web** eases `grid-template-rows` from `0fr` to `1fr`, the one way CSS can
 * transition to an unknown height without measuring it — the content can go on
 * changing size while open and the layout follows it natively. The clip is
 * only there while moving, so a focus ring or shadow inside is not cut off at
 * rest.
 *
 * **Native** hands the change to `LayoutAnimation`, which animates every frame
 * that moves in that commit — the row and the note it pushes — with the same
 * duration.
 *
 * Reduced motion skips all of it: the content is simply there or not.
 */
export function Reveal({
  open,
  children,
  appear = false,
  style,
  testID,
}: {
  open: boolean;
  children?: ReactNode;
  /**
   * Whether a Reveal that is already open on its first render eases in. Off by
   * default: a screen that loads with the row already there should not wobble
   * into place; the ease is for a change the reader watches happen.
   */
  appear?: boolean;
  /** Applied to the moving box — use it for margins, never for padding. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): JSX.Element | null {
  if (Platform.OS !== "web") return <NativeReveal open={open} style={style} testID={testID}>{children}</NativeReveal>;
  return <WebReveal open={open} appear={appear} style={style} testID={testID}>{children}</WebReveal>;
}

/**
 * `entering` draws collapsed, `opening` eases to full height still clipped,
 * `open` is at rest (unclipped), `leaving` eases back to nothing.
 */
type Phase = "closed" | "entering" | "opening" | "open" | "leaving";

function WebReveal({
  open,
  children,
  appear,
  style,
  testID,
}: {
  open: boolean;
  children?: ReactNode;
  appear: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): JSX.Element | null {
  const reduced = useSharedReducedMotion();
  const [phase, setPhase] = useState<Phase>(() => (open ? (appear ? "entering" : "open") : "closed"));
  const box = useRef<View>(null);

  // What to draw while the space closes: the last children rendered open.
  const last = useRef<ReactNode>(children);
  if (open) last.current = children;

  useEffect(() => {
    if (open) {
      if (phase === "closed") setPhase(reduced ? "open" : "entering");
      else if (phase === "leaving") setPhase("opening"); // turn around mid-close
      return;
    }
    if (phase !== "closed" && phase !== "leaving") setPhase(reduced ? "closed" : "leaving");
  }, [open, phase, reduced]);

  // Entering draws the collapsed box first, so there is a height to ease from:
  // reading layout commits that frame before the box is asked to open.
  useEffect(() => {
    if (phase !== "entering") return;
    (box.current as unknown as HTMLElement | null)?.getBoundingClientRect?.();
    setPhase("opening");
  }, [phase]);

  useEffect(() => {
    if (phase !== "leaving" && phase !== "opening") return;
    const timer = setTimeout(() => setPhase(phase === "leaving" ? "closed" : "open"), motion.layoutMs);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "closed") return null;
  const expanded = phase === "opening" || phase === "open";
  return (
    <View
      ref={box}
      testID={testID}
      aria-hidden={expanded ? undefined : true}
      style={[
        {
          display: "grid",
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
          transition: reduced
            ? "none"
            : `grid-template-rows ${motion.layoutMs}ms ${motion.ease}, opacity ${motion.layoutMs}ms ${motion.ease}`,
        } as unknown as ViewStyle,
        style,
      ]}
    >
      <View style={[{ minHeight: 0 }, phase === "open" ? null : { overflow: "hidden" }]}>
        {open ? children : last.current}
      </View>
    </View>
  );
}

function NativeReveal({
  open,
  children,
  style,
  testID,
}: {
  open: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): JSX.Element | null {
  const reduced = useSharedReducedMotion();
  const previous = useRef(open);
  /*
    `configureNext` has to be called before the commit it animates, so it is
    called here, in the render that carries the change, rather than in an
    effect (which runs after the frame has already jumped). It schedules and
    does nothing else, so a render React throws away costs one no-op.
  */
  if (previous.current !== open) {
    previous.current = open;
    if (!reduced) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(motion.layoutMs, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
      );
    }
  }
  if (!open) return null;
  return <View style={style} testID={testID}>{children}</View>;
}

/*
  Reduced motion, read once for every Reveal on the screen.

  `useReducedMotion` subscribes per caller, which is right for a toast and
  wrong here: every row of the file tree is wrapped in a Reveal, and a tree of
  five hundred notes would hold five hundred media-query listeners to learn one
  fact. Same answer and the same "assume reduced until known" start, one
  subscription.
*/
let reducedMotion = true;
let reducedMotionStarted = false;
const reducedMotionListeners = new Set<() => void>();

function setReducedMotion(value: boolean) {
  if (value === reducedMotion) return;
  reducedMotion = value;
  for (const listener of reducedMotionListeners) listener();
}

function subscribeReducedMotion(listener: () => void): () => void {
  reducedMotionListeners.add(listener);
  if (!reducedMotionStarted) {
    reducedMotionStarted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReducedMotion)
      .catch(() => setReducedMotion(false));
    // May be `undefined` on a host that stubs the API; see `useReducedMotion`.
    AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReducedMotion);
  }
  return () => reducedMotionListeners.delete(listener);
}

export function useSharedReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => reducedMotion, () => true);
}
