/**
 * The Live Preview editor's native half: a plain markdown textarea.
 *
 * CodeMirror is a DOM library. There is no React Native build of it, and the
 * two ways of pretending otherwise are both worse than this file:
 *
 *  - A **WebView** would put the note's text — and an auth-bearing surface —
 *    inside a second rendering context with its own keyboard handling, its own
 *    scroll physics, and a bridge to marshal every keystroke across. On a
 *    document editor that is a worse experience than a native text input, not a
 *    better one.
 *  - **Reimplementing the decorations against `TextInput`** is not possible in
 *    the way that matters: React Native's `TextInput` cannot hide a range of
 *    its own value while keeping it in the buffer, which is the entire
 *    behaviour.
 *
 * So the native app keeps the editor it already had, and the console — which is
 * a web surface, on a laptop, where this editing actually happens — gets Live
 * Preview. That gap is deliberate and is the "document deliberate gaps" the
 * handoff asked for rather than an omission to be fixed later.
 *
 * The props are identical to the web component's on purpose: `NoteEditor` does
 * not branch on platform, Metro picks the file, and neither half can drift from
 * the other's contract without failing typecheck.
 */

import { StyleSheet, TextInput } from "react-native";
import { colors, fonts, leading, radii } from "../../design/tokens";
import type { LiveEditorProps } from "./LiveEditor.web";

export type { LiveEditorProps };

export function LiveEditor({
  value,
  editable,
  onChange,
  accessibilityLabel,
}: LiveEditorProps) {
  return (
    <TextInput
      multiline
      editable={editable}
      value={value}
      onChangeText={onChange}
      style={styles.editor}
      accessibilityLabel={accessibilityLabel}
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

const styles = StyleSheet.create({
  /**
   * `.note pre`, made editable — the same surface the mockup specifies, and the
   * same one this editor had before Live Preview existed on web.
   */
  editor: {
    flex: 1,
    minHeight: 160,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    color: colors.text2,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.7),
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
});
