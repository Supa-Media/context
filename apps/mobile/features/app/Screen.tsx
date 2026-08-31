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
import { surfacePadding, type ChromeHeights, type SurfacePadding } from "./frame";

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
 * They are **not paid in the same place**, and an earlier version of this file
 * said they were. Both numbers went on the content container, which is correct
 * for the first rule and useless for the second: content padding scrolls away
 * with the content, so every screen cleared the notch at rest and drew its text
 * across the clock the moment anybody swiped. The verification pass found
 * `BUCKET` at 50pt and body type at 7pt, behind the Dynamic Island.
 *
 * So the system's top band is spent on the view *around* the scroller, where it
 * shortens the viewport and survives scrolling, and our own chrome stays on the
 * content, where it can still be scrolled clear. `SurfacePadding` in `frame.ts`
 * is that split; `__tests__/safeArea.test.ts` scrolls each screen and asserts
 * the second half rather than trusting the first.
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
 * The mark on the *content container* of a scrolling surface.
 *
 * `SAFE_AREA_MARK` lands on the box around the scroller, which is where the
 * system's band is paid; this names the box inside it, which is where our own
 * chrome is. The guard reads them as one surface at rest and as two the moment
 * it scrolls — which is the whole distinction, made visible in the DOM so a
 * test can assert on it rather than on the source.
 */
export const SAFE_AREA_CONTENT_MARK = { dataSet: { safeArea: "content" } } as const;

/**
 * The padding this surface owes at each edge, split by where it has to be spent.
 *
 * Exported for the two surfaces that cannot be a `Screen` because something
 * else already owns their scroller — `BrowsePane`'s folder page and
 * `NoteEditor`'s document, which needs the keyboard accessory bar as a sibling
 * of its scroller rather than inside it. They spend the same numbers from the
 * same function, in the same two places; what they do not get is the marker, so
 * the guard covers them through the route that mounts them.
 */
export function useSurfacePadding(chrome?: ChromeHeights): SurfacePadding {
  const frame = useFrame();
  const systemInsets = useSafeAreaInsets();
  return surfacePadding({
    systemInsets,
    frameInsets: frame.contentInsets,
    frameViewport: frame.viewportInsets,
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
 * A screen that scrolls, with each edge paid where it actually works.
 *
 * **The box around the scroller holds the system's band back.** That is the
 * only kind of padding that survives a swipe: everything on the content
 * container scrolls with the content, so a status-bar inset spent there keeps
 * the first line clear and lets the twentieth run straight across the clock.
 * `paddingTop` on the `ScrollView`'s own `style` is no better — a scroll
 * container clips at its padding box, so its content rides up into that band
 * too — which is why this is a wrapping `View` and not a prop.
 *
 * **Our own chrome stays on the content container**, where it belongs: the
 * first and last lines can each be scrolled out from under whatever floats over
 * them and everything between passes behind. `scrollIndicatorInsets` carries
 * the same two numbers, because a scrollbar that runs under the notch is the
 * same defect in miniature.
 *
 * The caller's `contentContainerStyle` is applied *after* the padding, so a
 * screen that genuinely needs its own top padding can still say so — and one
 * that sets `paddingTop` by accident loses our chrome's share of it, which is
 * what the guard is watching for.
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
    <View
      {...SAFE_AREA_MARK}
      style={[
        styles.fill,
        { paddingTop: padding.viewport.top, paddingBottom: padding.viewport.bottom },
      ]}
    >
      <ScrollView
        style={[styles.fill, style]}
        contentContainerStyle={[
          { paddingTop: padding.content.top, paddingBottom: padding.content.bottom },
          contentContainerStyle,
        ]}
        {...SAFE_AREA_CONTENT_MARK}
        scrollIndicatorInsets={{ top: padding.content.top, bottom: padding.content.bottom }}
        {...rest}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/**
 * The box that holds the system's band back from a scroller somebody else owns.
 *
 * `NoteEditor` and `BrowsePane` cannot be a `ScreenScroll` — one needs the
 * keyboard accessory bar as a *sibling* of its scroller, the other switches
 * between a page scroller and a note that brings its own — so they build the
 * `ScrollView` themselves and wrap it in this. Same two numbers, same two
 * places, one component rather than the same `paddingTop` written out twice and
 * then only fixed once.
 */
export function ScreenViewport({
  padding,
  style,
  children,
}: {
  padding: SurfacePadding;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        styles.fill,
        { paddingTop: padding.viewport.top, paddingBottom: padding.viewport.bottom },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
