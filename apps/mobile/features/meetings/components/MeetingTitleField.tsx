import { memo, useRef } from "react";
import { StyleSheet, TextInput } from "react-native";
import { fonts } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * The meeting's name, as a field rather than a heading.
 *
 * ## Why this did not exist, and what it cost
 *
 * `controller.setTitle` has been in this feature since the contract had a
 * `title` event, and until this component it **had no callers at all** — the
 * live screen rendered `session.title` as static text and the note screen
 * rendered it as static text, so every meeting this app has ever recorded is
 * called "New meeting". The owner's report is the shortest statement of the
 * defect: *"i can't even edit the meeting title."*
 *
 * The name is not decoration. It is the `# <title>` heading of the note, it is
 * the row somebody scans the meetings list for, and — on this app's writer — it
 * is the slug in the key the note is filed under (`meetingNotePath`). A
 * recorder that files every meeting under the same name has made its own list
 * unreadable.
 *
 * ## Uncontrolled, by the same rule `NotesPad` is
 *
 * Transcript segments land while somebody is typing. The elapsed clock ticks
 * once a second. Neither may move the caret in this field any more than it may
 * in the notepad, and the guarantee is structural rather than careful: seeded
 * once with `defaultValue`, `memo`'d on props that do not change, and the
 * store is *told* what was typed and never tells the input.
 *
 * ## An empty field is not an empty title
 *
 * `normalizeTitle` in `@context/meetings/session` collapses whitespace and
 * falls back to "New meeting" for a string with nothing in it, so clearing the
 * field cannot produce a note headed `# ` or a key with an empty slug. The
 * placeholder says the name that fallback will use, so the screen agrees with
 * the reducer instead of leaving somebody looking at a blank line and guessing.
 */
export interface MeetingTitleFieldProps {
  /** Seeds the control once. Later changes are ignored — see above. */
  initialValue: string;
  /** Must be stable across renders. Hold it in a `useCallback`. */
  onChangeText: (text: string) => void;
  /** What an empty field will be saved as. `normalizeTitle`'s own fallback. */
  placeholder: string;
  testID?: string;
}

function MeetingTitleFieldImpl({
  initialValue,
  onChangeText,
  placeholder,
  testID,
}: MeetingTitleFieldProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const seed = useRef(initialValue).current;

  return (
    <TextInput
      testID={testID}
      defaultValue={seed}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.heroDim}
      // A title is one line. Newlines are collapsed by the reducer anyway, and
      // a Return here should put the keyboard away rather than grow the field
      // over the notepad this screen exists to keep clear.
      multiline={false}
      returnKeyType="done"
      // Names of people, products and projects, in somebody's own shorthand.
      // The same argument `NotesPad` makes, for the same reason.
      autoCorrect={false}
      autoCapitalize="sentences"
      spellCheck={false}
      accessibilityLabel="The name of this meeting"
      style={styles.title}
    />
  );
}

/**
 * Memoised on identity — `initialValue` is read once, `onChangeText` is held in
 * a `useCallback` by the caller, and the rest are primitives. So a segment
 * arriving re-renders the screen around this field and this field not at all.
 */
export const MeetingTitleField = memo(MeetingTitleFieldImpl);

const makeStyles = (colors: Colors) => StyleSheet.create({
  /*
    The heading it replaces, to the pixel: `LiveMeetingScreen`'s own `title`
    style. A field that is one point off is a field somebody can see is a
    field, and this is the meeting's name whether or not anybody is editing it.
  */
  title: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 30,
    letterSpacing: -0.75,
    fontWeight: "600",
    color: colors.text,
    // Zero rather than the platform default, so the text sits where the
    // heading sat. Android gives a `TextInput` its own vertical padding.
    padding: 0,
    // RN Web draws a focus ring on a `TextInput`. The caret and the keyboard
    // are what say this is focused; a box around the meeting's name is noise.
    // `outlineWidth` rather than `outlineStyle`, which React Native's own
    // `TextStyle` types as solid/dotted/dashed — see `NotesPad`.
    outlineWidth: 0,
  },
});
