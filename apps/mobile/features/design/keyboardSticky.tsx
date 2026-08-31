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
 */

import { StyleSheet } from "react-native";
import { KeyboardController, KeyboardStickyView } from "react-native-keyboard-controller";
import type { KeyboardStickyProps } from "./keyboardSticky.web";

export type { KeyboardStickyProps };

export function KeyboardSticky({ children, style }: KeyboardStickyProps) {
  return <KeyboardStickyView style={[styles.sticky, style]}>{children}</KeyboardStickyView>;
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

const styles = StyleSheet.create({
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
