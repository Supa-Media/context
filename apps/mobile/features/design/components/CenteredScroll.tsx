import type { ReactNode } from "react";
import { StyleSheet, type ViewStyle } from "react-native";
import { ScreenScroll } from "../../app/Screen";

/**
 * A page that centres its content on a tall screen and scrolls on a short one.
 *
 * ## The bug this exists to remove
 *
 * The consent screen and the login screen were each a `flex: 1` container with
 * `justifyContent: "center"` and `overflow: "hidden"`, and **no ScrollView**.
 * On the web that is a page that cannot scroll in either direction: `+html.tsx`
 * emits Expo Router's `ScrollViewStyleReset`, which switches document scrolling
 * off so the body cannot fight a React Native `ScrollView`. Centred content
 * taller than the viewport therefore overflows *both* ends and is clipped by
 * `overflow: hidden` — unreachable, with nothing to scroll.
 *
 * The consent body runs roughly 700–900px with a context chooser and three or
 * four scope lines. On a 390×700 phone browser — which is where an AI client's
 * OAuth redirect lands somebody — **Approve and Deny were off the bottom of the
 * screen and could not be reached, so the flow could not be completed on a
 * phone at all.** Login clipped the same way as soon as the soft keyboard took
 * half the viewport.
 *
 * ## How one component does both jobs
 *
 * `flexGrow: 1` on the *content container* is the whole trick. Shorter than the
 * viewport, the container stretches to fill it and `justifyContent: "center"`
 * centres the children — the tall-desktop look is unchanged. Taller than the
 * viewport, the container grows past it, the overflow lands on the ScrollView
 * (which owns `overflow-y: auto`) rather than on a clipped flex box, and every
 * control stays reachable.
 *
 * `keyboardShouldPersistTaps="handled"` is not decoration either: without it the
 * first tap on a button while a field has focus is swallowed dismissing the
 * keyboard, which on the login screen means Verify appears not to work.
 *
 * ## Why it is a `ScreenScroll` and not its own `ScrollView`
 *
 * This is the scroll surface for six of the eight screens outside the console —
 * login, consent, both invitation screens, the share viewer and the Dropbox
 * callback — and until this it applied no safe-area padding at all. The share
 * viewer had no inner wrap either, so its card ran flush to the top of the
 * glass and its first line sat under the Dynamic Island.
 *
 * The centring is unchanged: `ScreenScroll` puts the insets on the content
 * container *before* this component's own style, so `flexGrow: 1` and
 * `justifyContent: "center"` still decide the layout inside the padded box. On
 * the web the padding is zero and this is exactly the component it was.
 */
export function CenteredScroll({
  children,
  style,
  contentStyle,
  testID,
}: {
  children: ReactNode;
  style?: ViewStyle;
  contentStyle?: ViewStyle;
  testID?: string;
}) {
  return (
    <ScreenScroll
      style={style}
      contentContainerStyle={[styles.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      testID={testID}
    >
      {children}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: "center" },
});
