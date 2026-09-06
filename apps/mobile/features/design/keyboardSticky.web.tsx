/**
 * Something that rides above the soft keyboard — the web half, which is the
 * half that needs no library at all.
 *
 * A mobile browser does not draw the keyboard over the page the way an app
 * does: it shrinks the **layout viewport** to what is left above it, and the
 * document reflows into that. So content anchored to the bottom of a region
 * that ends at the bottom of the glass is already sitting above the keyboard,
 * and there is nothing to track and nothing to animate. `position: absolute`
 * with `bottom: 0` is the whole implementation.
 *
 * This is the *declaring* half of the pair even though the interesting work is
 * on native, for the same reason `LiveEditor.web.tsx` declares `LiveEditorProps`:
 * the native half imports the type from here, so the two cannot drift without
 * failing typecheck, and no caller ever has to ask which platform it is on.
 *
 * ## Why there is a `.web` half at all
 *
 * `react-native-keyboard-controller` is a native module. Metro would happily
 * resolve it in a web bundle and hand the browser a module whose views do not
 * exist, and `@supa-media/linter`'s `platform-file-pairs` exists precisely to
 * stop a file like the native half shipping without a counterpart. An absent
 * capability is reported honestly here rather than faked: the browser genuinely
 * does this for us, so the fallback is not a no-op, it is the real answer.
 */

import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

export interface KeyboardStickyProps {
  children: ReactNode;
  /**
   * So a test can find the anchored wrapper rather than inferring it.
   *
   * Worth a prop: what a caller is buying here is *that the thing is anchored*,
   * and on the web that is a computed style on a `View` nothing else names.
   * `meetingsScreens.test.ts` asserts End is inside it, which is the claim.
   */
  testID?: string;
  /**
   * Merged **after** the bottom anchoring, so a caller can add padding or a
   * background without having to restate the positioning — and cannot
   * accidentally leave the two halves anchored differently.
   */
  style?: StyleProp<ViewStyle>;
}

export function KeyboardSticky({ children, style, testID }: KeyboardStickyProps) {
  return (
    <View style={[styles.sticky, style]} testID={testID}>
      {children}
    </View>
  );
}

/**
 * Put the keyboard away.
 *
 * There is no browser API for "hide the soft keyboard"; what there is, is the
 * rule that it is shown for a focused editable element and hidden when nothing
 * is focused. So blurring the active element is not a workaround for the real
 * call — on this platform it *is* the real call.
 *
 * Guarded on `document` because this module is imported by a component that is
 * also rendered by the jsdom-free half of the test suite, and a `ReferenceError`
 * thrown from a dismiss button is a worse failure than a dismiss that has
 * nothing to dismiss.
 */
export function dismissKeyboard(): void {
  if (typeof document === "undefined") return;
  (document.activeElement as HTMLElement | null)?.blur();
}

/**
 * How much of the bottom of the screen the keyboard is covering. Always `0`.
 *
 * **Zero is the answer, not a stub.** A mobile browser shrinks the layout
 * viewport to what is left above the keyboard and the document reflows into it,
 * so a surface that ends at the bottom of the glass has already ended above the
 * keyboard. A caller that subtracted a height here would take the room twice
 * and push the caret up by a keyboard that is not covering anything —
 * `NoteEditor.web` refuses the same margin for the same reason.
 *
 * It is a hook rather than a constant so the two halves have one signature and
 * the caller never branches, which is this pair's whole arrangement.
 */
export function useKeyboardHeight(): number {
  return 0;
}

/**
 * No palette here, so this may be a module-level `StyleSheet.create`: the rule
 * in `CLAUDE.md` is that no module may *hold a palette*, and these three
 * numbers are geometry.
 */
const styles = StyleSheet.create({
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
