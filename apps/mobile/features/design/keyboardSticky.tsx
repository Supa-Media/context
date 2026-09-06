/**
 * Something that rides above the soft keyboard — the native half.
 *
 * On iOS and Android the keyboard is drawn *over* the app rather than taking
 * room from it, so bottom-anchored content is behind it and stays there. What
 * is needed is a view that translates upward by exactly the keyboard's height,
 * in step with the keyboard's own animation curve — which is what
 * `KeyboardStickyView` from `react-native-keyboard-controller` is. It is a
 * `core` dependency in `native-deps.json` (so a static import is allowed) and
 * `app/_layout.tsx` already mounts the `KeyboardProvider` it reads from, so
 * this adds no dependency and no provider.
 *
 * The props come from `./keyboardSticky.web`, which is the arrangement
 * `LiveEditor` already uses: one declaration, imported by the other half, so a
 * caller never branches on platform and the two cannot drift without failing
 * typecheck. The web half also carries the argument for why the pair exists.
 *
 * ## What this does not try to do
 *
 * It has no `offset`. `KeyboardStickyView` translates from wherever the view
 * rests, so how flush the result sits against the keyboard is decided by the
 * caller's container, not here — and a number typed in this file would be a
 * guess about somebody else's layout. See `NoteAccessory`, which records what
 * that costs today.
 *
 * **What a caller therefore owes, both of which have been forgotten once.** An
 * absolutely-positioned child is laid out against its parent's *padding box*,
 * so `bottom: 0` here ignores a screen's safe-area `paddingBottom` and the bar
 * lands in the home-indicator band unless the caller pays that inset itself.
 * And a bar lifted by the keyboard's full height lands *inside* whatever the
 * keyboard was covering, so a caller whose content did not shrink has put an
 * opaque control in the middle of its own text. `useKeyboardHeight` below is
 * the second half; `NoteAccessory` and `LiveMeetingScreen` are the two callers
 * and both now pay both.
 */

import { StyleSheet } from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
import type { KeyboardStickyProps } from "./keyboardSticky.web";

export type { KeyboardStickyProps };

export function KeyboardSticky({ children, style, testID }: KeyboardStickyProps) {
  return (
    <KeyboardStickyView style={[styles.sticky, style]} testID={testID}>
      {children}
    </KeyboardStickyView>
  );
}

/**
 * Put the keyboard away.
 *
 * `KeyboardController.dismiss()` rather than `Keyboard.dismiss()` from
 * react-native: the app already runs the controller's provider, and mixing the
 * two means one of them animating a keyboard the other has already decided is
 * gone. The promise is deliberately dropped — the caller has nothing to do
 * once the animation finishes, and awaiting it in a press handler would only
 * open a window in which the component can unmount.
 */
export function dismissKeyboard(): void {
  void KeyboardController.dismiss();
}

/**
 * How much of the bottom of the screen the keyboard is covering.
 *
 * A caller uses it to give up exactly that much of its content box, so that
 * what this module lifts lands on room the caller made rather than over the
 * text somebody is typing. `useKeyboardState` is the plain-React half of this
 * library rather than the reanimated one, deliberately: the value has to reach
 * a `style` prop React renders, and a shared value cannot.
 *
 * A re-render per keyboard movement is affordable on the one screen that reads
 * it, because `NotesPad` is memoised on props that do not change — the whole
 * point of that memo — so the notepad is not among the things re-rendered.
 */
export function useKeyboardHeight(): number {
  return useKeyboardState((state) => state.height);
}

const styles = StyleSheet.create({
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
