import type { ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFrame } from "./AppFrame";
import { surfacePadding, type ChromeHeights, type EdgePadding } from "./frame";

/**
 * The one way a screen clears the system's furniture.
 *
 * ## The bug this exists to make unrepeatable
 *
 * The settings screen rendered its title, its "Connected" pill and its Done
 * button **underneath the status bar and the Dynamic Island** — "@seyi
 * settings" sharing a line with the clock. It was not a settings bug. Five
 * files in the whole app touched `useSafeAreaInsets` against thirteen routes,
 * so every screen that did not happen to go through `AppFrame` was exposed, and
 * fixing the one on the screenshot would have left the other seven waiting for
 * somebody to notice them.
 *
 * So this is a primitive rather than a patch, and the arithmetic behind it is
 * `surfacePadding` in `frame.ts` — one function, tested on its own, with
 * `__tests__/safeArea.test.ts` enumerating the route files and failing when a
 * screen renders content that does not come through here.
 *
 * ## The distinction that makes it subtle
 *
 * Two different things sit over a scroll surface and only one of them is ours:
 *
 * - Content **should** pass under our own floating chrome — the toggle button,
 *   the trailing action group, the bottom pill. They are translucent objects
 *   lying on the document, which is how Obsidian draws them and why body text
 *   is visible to the left and right of the bottom pill on the lines it covers.
 * - Content must **never** be laid out under the status bar, the Dynamic Island
 *   or the home indicator. Those are the system's.
 *
 * Both are paid the same way and for the same reason: as padding on the
 * *content*, never as a shorter viewport. A scroller that stops where the
 * toolbar begins draws a hard edge across the glass and cannot scroll its last
 * line clear of anything.
 *
 * ## Why there is no platform branch at a call site
 *
 * On the web `useSafeAreaInsets` reports zeros and `AppFrame` reports zeros, so
 * the padding is zero and these components are the shape they always were. The
 * `.web` split some other modules need does not apply: there is nothing to
 * stub, only a number that happens to be nothing.
 */

/* -------------------------------------------------------------------------- */

/**
 * The mark a guard can see, spread rather than written as a prop.
 *
 * `dataSet` is react-native-web's documented escape hatch to `data-*`
 * attributes and is dropped on native, which is the same trade `AppFrame`'s
 * `INERT` makes in the other direction. It exists so `safeArea.test.ts` can
 * assert *the rendered tree* went through this module rather than grepping the
 * source for an import — an import guard that reads English prose as code is
 * one of the three failures "A guard nobody has checked is not a guard" was
 * written about.
 *
 * Frozen and shared: a fresh object per render is a fresh prop identity for
 * every surface in the app.
 */
export const SAFE_AREA_MARK = { dataSet: { safeArea: "surface" } } as const;

/**
 * The padding this surface owes at each edge, system insets and our own chrome
 * together.
 *
 * Exported for the two surfaces that cannot be a `Screen` because something
 * else already owns their scroller — `BrowsePane`'s folder page and
 * `NoteEditor`'s document, which needs the keyboard accessory bar as a sibling
 * of its scroller rather than inside it. They spend the same number from the
 * same function; what they do not get is the marker, so the guard covers them
 * through the route that mounts them.
 */
export function useSurfacePadding(chrome?: ChromeHeights): EdgePadding {
  const frame = useFrame();
  const systemInsets = useSafeAreaInsets();
  return surfacePadding({
    systemInsets,
    frameInsets: frame.contentInsets,
    framed: frame.framed,
    chrome,
  });
}

/* -------------------------------------------------------------------------- */

export interface ScreenProps {
  children: ReactNode;
  /** Our own floating chrome over this surface, added to the system's insets. */
  chrome?: ChromeHeights;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A screen that does not scroll.
 *
 * Fills what it is given and pads itself clear of both edges. Anything pinned
 * to the top of a screen — a header, a title, a close button — belongs inside
 * one of these rather than carrying `insets.top` of its own.
 */
export function Screen({ children, chrome, style, testID }: ScreenProps) {
  const padding = useSurfacePadding(chrome);
  return (
    <View
      {...SAFE_AREA_MARK}
      style={[styles.fill, { paddingTop: padding.top, paddingBottom: padding.bottom }, style]}
      testID={testID}
    >
      {children}
    </View>
  );
}

export interface ScreenScrollProps extends Omit<ScrollViewProps, "contentContainerStyle"> {
  children: ReactNode;
  /** Our own floating chrome over this surface, added to the system's insets. */
  chrome?: ChromeHeights;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

/**
 * A screen that scrolls, full-bleed, with both edges paid for in content
 * padding.
 *
 * The viewport is the whole region; the padding is on the content container, so
 * the first and last lines can each be scrolled out from under whatever floats
 * over them and everything between passes behind. `scrollIndicatorInsets`
 * carries the same two numbers, because a scrollbar that runs under the notch
 * is the same defect in miniature.
 *
 * The caller's `contentContainerStyle` is applied *after* the padding, so a
 * screen that genuinely needs its own top padding can still say so — and one
 * that sets `paddingTop` by accident loses the inset, which is what the guard
 * is watching for.
 */
export function ScreenScroll({
  children,
  chrome,
  style,
  contentContainerStyle,
  ...rest
}: ScreenScrollProps) {
  const padding = useSurfacePadding(chrome);
  return (
    <ScrollView
      {...SAFE_AREA_MARK}
      style={[styles.fill, style]}
      contentContainerStyle={[
        { paddingTop: padding.top, paddingBottom: padding.bottom },
        contentContainerStyle,
      ]}
      scrollIndicatorInsets={{ top: padding.top, bottom: padding.bottom }}
      {...rest}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
