import { Platform, type TextStyle, type ViewStyle } from "react-native";

/**
 * How a full tab strip shares its row: Chrome's rule, kept out of
 * `TabStrip.tsx` so the strip draws and this decides how wide things get.
 *
 * Tabs keep their natural width while they fit, take an even share once the
 * row is full, fade their titles when squeezed, and only scroll past
 * `TAB_MIN_WIDTH`. Every value here is checked in a browser by
 * `e2e/webkit/tabStripFit.spec.ts`, because jsdom lays nothing out.
 */

/**
 * The narrowest a tab gets before the strip scrolls instead: Chrome's floor,
 * where a tab is its first two or three letters. The front tab's floor is wider
 * because it keeps its ×, which is what Chrome does too — the tab you are
 * reading is the one you are most likely to close.
 */
export const TAB_MIN_WIDTH = 44;
export const ACTIVE_TAB_MIN_WIDTH = 112;

/**
 * Below this even share, a tab in the back gives its ✕'s box to its letters.
 *
 * Decided from the share rather than from each tab's own width, because the ✕
 * is part of what sets that width: a tab that hid its ✕ because it was narrow
 * would be narrower for having hidden it, and would never get it back.
 */
const TIGHT_SHARE = 96;

/**
 * A title that runs out of room fades over its last 16pt. Web only, like
 * `SHARE`: a mask is CSS with no React Native equivalent.
 */
export const LABEL_FADE: TextStyle | null =
  Platform.OS === "web"
    ? ({
        // The label fills its tab, so the fade sits at the tab's edge and a
        // title short enough to fit is never faded.
        // The fade's own 16pt is padding, so a tab at its natural width
        // fades only air and keeps every letter of a short title.
        flexGrow: 1,
        paddingRight: 16,
        whiteSpace: "nowrap",
        overflow: "hidden",
        maskImage: "linear-gradient(to right, #000 calc(100% - 16px), transparent)",
        WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 16px), transparent)",
      } as unknown as TextStyle)
    : null;

/**
 * The strip's ends fade over 24pt where tabs run past them, so a scrolled row
 * does not end in a tab cut flat against the file tree. Alpha only, so it is
 * the same in both themes.
 */
export function edgeFade({ before, after }: { before: boolean; after: boolean }): ViewStyle | null {
  if (Platform.OS !== "web" || !(before || after)) return null;
  const mask = `linear-gradient(to right, ${before ? "transparent, #000 24px" : "#000, #000"}, ${
    after ? "#000 calc(100% - 24px), transparent" : "#000"
  })`;
  return { maskImage: mask, WebkitMaskImage: mask } as unknown as ViewStyle;
}

/** Whether `count` tabs sharing `width` are past the point where every one can keep a ✕. */
export function tabsAreTight(width: number, count: number): boolean {
  // Unmeasured — jsdom, or the first frame — is never tight.
  if (width <= 0 || count === 0) return false;
  return width / count < TIGHT_SHARE;
}

/**
 * Chrome's sharing rule, in CSS: every tab starts from nothing and grows by an
 * equal share, but never past its own label (`max-content`). So until the row
 * is full each tab is exactly as wide as its title, and once it is full they
 * are an even share each — the short ones keeping their natural width and
 * handing the rest to the long ones — down to `TAB_MIN_WIDTH`, where the strip
 * overflows and scrolls.
 *
 * `max-content` is a CSS keyword with no React Native equivalent, so it is web
 * only, which is the only place a second tab can be opened (see `TabStrip.tsx`'s file
 * comment). Elsewhere a tab shrinks from its natural width, which is the same
 * answer for the one tab a native tablet ever shows.
 */
export const SHARE: ViewStyle =
  Platform.OS === "web"
    ? ({ flexGrow: 1, flexShrink: 1, flexBasis: 0, maxWidth: "max-content" } as unknown as ViewStyle)
    : { flexGrow: 0, flexShrink: 1 };
