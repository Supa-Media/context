import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { ScreenViewport } from "../../../app/Screen";
import type { NoteView } from "./view";

/**
 * The phone's one full-bleed scroll surface around `flow`. Called from
 * `NoteEditor`'s render, at compact only; see the comment at the call site.
 */
export function noteScroller(view: NoteView, flow: ReactNode) {
  const { padding, scroller, styles, moving, settledAt, offset } = view;
  /*
    The status bar's band is held back *outside* the scroller and our own
    chrome is paid inside it, which is the whole of `SurfacePadding` and
    the reason this is a wrapping view rather than one more number in
    `contentContainerStyle`. Content padding scrolls away with the
    content: with the notch spent there, the first line of a note cleared
    the Dynamic Island and the twentieth ran straight across it — the
    verification pass measured body type at 7pt.
  */
  return (
    <ScreenViewport padding={padding}>
      <ScrollView
        ref={scroller}
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: padding.content.top,
          paddingBottom: padding.content.bottom,
        }}
        /*
          Room to scroll the caret clear of the keyboard, from the platform
          rather than from arithmetic here. Without it the last screenful of
          a note has nowhere to go: the content padding below only clears the
          floating toolbar, and the keyboard is five times its height.

          iOS-only and a no-op elsewhere, which is the right shape — this is
          a UIScrollView content inset, and the web's own scroller already
          shrinks with the layout viewport when a keyboard opens.
        */
        automaticallyAdjustKeyboardInsets
        /*
          A tap on the note while the keyboard is up is a tap into the
          editor, not a dismissal. The default would let this scroller eat
          the first touch to put the keyboard away — and on this surface the
          keyboard's way out is the accessory bar's own key, because the web
          view has no drag-to-dismiss. See `LiveEditor`'s `scrollEnabled`.

          This is the whole of what the web view needed to receive touches
          inside this scroller. `delaysContentTouches={false}` was the other
          suspect and is neither: it is not in React Native's
          `ScrollViewProps` at all, and Fabric's `RCTScrollViewComponentView`
          hardcodes `delaysContentTouches = NO` on every scroll view it
          mounts, so it was an untyped prop asking for the value the
          platform had already set.
        */
        keyboardShouldPersistTaps="handled"
        scrollIndicatorInsets={{
          top: padding.content.top,
          bottom: padding.content.bottom,
        }}
        /*
          The gesture, start to finish — see `moving`/`settledAt` above.
          `onScrollEndDrag` and `onMomentumScrollBegin` overlap by design:
          a fling re-raises the flag the finger lifting lowered, which is
          what keeps it true through the deceleration the focus lands in.

          `onScroll` marks the rest only. It is the *only* one of these
          react-native-web forwards to the DOM, so on the web — and in
          `noteAccessory.test.ts` — it is the whole of the signal.
        */
        onScrollBeginDrag={() => {
          moving.current = true;
        }}
        onMomentumScrollBegin={() => {
          moving.current = true;
        }}
        onScrollEndDrag={() => {
          moving.current = false;
          settledAt.current = Date.now();
        }}
        onMomentumScrollEnd={() => {
          moving.current = false;
          settledAt.current = Date.now();
        }}
        onScroll={(event) => {
          settledAt.current = Date.now();
          // Where `onScrollBy` adds its delta. Read defensively because the
          // web's forwarded scroll event carries a synthesised
          // `contentOffset` and this is the one number a stray `NaN` would
          // turn into a jump to the top of somebody's note.
          const y = event.nativeEvent.contentOffset?.y;
          if (typeof y === "number" && Number.isFinite(y)) offset.current = y;
        }}
        scrollEventThrottle={16}
        testID="note-scroll"
      >
        {flow}
      </ScrollView>
    </ScreenViewport>
  );
}
