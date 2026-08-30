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
 *
 * ## A phone reads the note; it does not inspect it
 *
 * On a pointer layout this is the mockup's `.note pre`: 12.5px mono in a
 * bordered well. That is a *source view*, and it is the right one beside a file
 * tree, a tab strip and a keyboard.
 *
 * It is the wrong one on a phone, where the note is the entire screen and the
 * person holding it is reading. 12.5px mono at arm's length is unreadable, the
 * border draws a box around the only thing on the glass, and a monospaced
 * measure wraps a sentence about every six words — which is the effect visible
 * in the before/after in the pull request. So at `compact` the same buffer is
 * drawn at reading size in the body face, unboxed, on the ground it already
 * sits on.
 *
 * **The buffer is untouched.** This is a type scale, not a renderer: what is on
 * screen is still exactly the markdown in the file, which is the property
 * `NoteEditor` exists to protect and the reason this app has no WYSIWYG.
 */

import { StyleSheet, TextInput, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { colors, fonts, leading, radii, space } from "../../design/tokens";
import type { LiveEditorProps } from "./LiveEditor.web";

export type { LiveEditorProps };

export function LiveEditor({
  value,
  editable,
  onChange,
  accessibilityLabel,
}: LiveEditorProps) {
  const reading = densityFor(useWindowDimensions().width) === "compact";
  return (
    <TextInput
      multiline
      editable={editable}
      value={value}
      onChangeText={onChange}
      style={[styles.editor, reading && styles.reading]}
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
  /**
   * See the file comment: the phone reads, it does not inspect.
   *
   * 16 on a 24 line box in 24 of side padding, measured off Obsidian mobile —
   * and the same three numbers the web half sets in CSS, because a note that
   * reflows differently on the two platforms is two documents.
   */
  reading: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: leading(16, 1.5),
    paddingTop: space.x2,
    paddingHorizontal: space.x6,
    paddingBottom: space.x8,
  },
});
