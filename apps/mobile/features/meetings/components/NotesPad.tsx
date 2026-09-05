import { memo, useRef } from "react";
import { StyleSheet, TextInput } from "react-native";
import { fonts, leading, layout } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * The thing this product is.
 *
 * A meeting recorder people keep is a **notepad first**: you open it, you hit
 * record, and you type your own sparse notes while the meeting happens. The
 * enhanced note afterwards follows the shape of whatever you bothered to write
 * down. So this control is the screen, and everything else on it is furniture
 * around it.
 *
 * ## The one rule, and the whole reason this is its own file
 *
 * **Typing is never interrupted by anything arriving from anywhere.** Transcript
 * segments land while somebody is mid-word; a sync settles; the elapsed clock
 * ticks once a second. None of those may move the caret, reset the selection,
 * drop a character, or scroll the view.
 *
 * The way that is guaranteed here is structural rather than careful:
 *
 * 1. **This component is uncontrolled.** `defaultValue` seeds it once; there is
 *    no `value` prop. A controlled input round-trips every keystroke through
 *    the store and back, and on React Native that is exactly how a fast typist
 *    loses characters and how an autocorrect suggestion gets reverted mid-word.
 *    The store is *told* what was typed; it never tells the input.
 * 2. **It is `memo`'d on props that do not change.** `onChangeText` is the only
 *    one that could, and the caller holds it in a `useCallback`, so a segment
 *    arriving re-renders the screen around this control and re-renders *this*
 *    control not at all. `meetingsTyping.test.ts` asserts the render count, not
 *    the appearance, because appearance is what a broken version also gets
 *    right at rest.
 * 3. **Nothing in this file reads the session.** There is no path by which a
 *    transcript could reach it, which is stronger than a rule saying it must
 *    not.
 *
 * The mockup makes the same argument visually: the transcript is reduced to a
 * status chip at the bottom of the screen rather than a scrolling column,
 * precisely so that nothing about it can compete with the caret.
 *
 * ## Why the text is Markdown and is not rendered as Markdown
 *
 * It lands in the customer's own bucket as Markdown (non-negotiable #3) and it
 * is *theirs* — "never rewritten by the enhancement pass". Live preview is a
 * CodeMirror surface in this app (`console/files/LiveEditor`), which is a
 * WebView on a phone; putting one under a meeting's notepad would mean typing
 * into a WebView while the app is trying not to drop a frame. Plain text with a
 * monospace-free reading face is what a person actually wants at speed, and the
 * note is rendered properly everywhere it is read afterwards.
 */
export interface NotesPadProps {
  /** Seeds the control once. Later changes are ignored — see rule 1. */
  initialValue: string;
  /** Must be stable across renders. Hold it in a `useCallback`. */
  onChangeText: (text: string) => void;
  /** Focus on mount. True on the live screen: the notepad is the screen. */
  autoFocus?: boolean;
  editable?: boolean;
  placeholder?: string;
  testID?: string;
}

function NotesPadImpl({
  initialValue,
  onChangeText,
  autoFocus = false,
  editable = true,
  placeholder = "Type your notes…",
  testID,
}: NotesPadProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  /*
    Held so the seed cannot change identity across a re-render of a parent that
    passes a fresh string. `defaultValue` is only read on mount, so this is
    belt and braces — but the belt is what makes it impossible for a future
    caller to reintroduce the bug by passing `session.notes` straight through.
  */
  const seed = useRef(initialValue).current;

  return (
    <TextInput
      testID={testID}
      defaultValue={seed}
      onChangeText={onChangeText}
      autoFocus={autoFocus}
      editable={editable}
      multiline
      // The keyboard's Return key inserts a newline rather than submitting:
      // this is a document, not a field.
      blurOnSubmit={false}
      textAlignVertical="top"
      scrollEnabled
      placeholder={placeholder}
      placeholderTextColor={colors.heroDim}
      // Every one of these is off because this is prose somebody is taking down
      // at speed, in their own shorthand, with names and jargon in it.
      // Autocorrect rewriting a surname mid-meeting is the single most annoying
      // thing a notepad can do.
      autoCorrect={false}
      autoCapitalize="sentences"
      spellCheck={false}
      accessibilityLabel="Your notes for this meeting"
      style={styles.pad}
    />
  );
}

/**
 * Memoised on identity.
 *
 * The default comparison is exactly right here: `initialValue` is read once and
 * every other prop is a primitive or a stable callback, so the only thing that
 * can re-render this control is the caller genuinely changing one of them.
 */
export const NotesPad = memo(NotesPadImpl);

const makeStyles = (colors: Colors) => StyleSheet.create({
  pad: {
    flex: 1,
    // The reading measure every band on a note screen shares — the editor's own
    // padding, the breadcrumb, the notices — so the first character of the
    // notes lines up with the title above it.
    paddingHorizontal: layout.readingMargin,
    paddingTop: 4,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: leading(16, 1.62),
    color: colors.text,
    // RN Web draws a focus ring on a `TextInput`; the pad *is* the screen, so a
    // ring around the whole of it is noise. Focus is unmistakable here — the
    // caret is in it and the keyboard is up. `outlineWidth` rather than
    // `outlineStyle: "none"`, which React Native's own `TextStyle` does not
    // accept: its union is solid/dotted/dashed, and a zero width is the same
    // picture through a property both platforms type.
    outlineWidth: 0,
  },
});
