/**
 * A markdown mark typed over selected words wraps them instead of replacing
 * them.
 *
 * Select "Ruth", press `[` twice, and the note says `[[Ruth]]` — a link to the
 * note named Ruth. Press `*` twice and it is bold, `=` twice and it is
 * highlighted. That is what Obsidian, Typora and every other markdown editor
 * people arrive from do, and an editor that instead throws the words away and
 * leaves a lone `[` punishes the most ordinary thing anybody does with it.
 *
 * ## Why the words stay selected
 *
 * The doubled marks (`[[ ]]`, `** **`, `== ==`, `~~ ~~`) are each two presses
 * of one key. Keeping the same words selected after the first press is what
 * lets the second press wrap again rather than replace — so one rule, applied
 * twice, produces every doubled mark without this file knowing which marks
 * are doubled.
 *
 * ## Why an input handler and not a key binding
 *
 * A key binding sees the physical key, and `[` is a different key on a German
 * keyboard, and no key at all on a phone, where the character arrives from the
 * on-screen keyboard as text input. The input handler sees the character
 * whichever way it came, which is why the web console, the Mac app and the
 * phone's editor all get this from the one line in `editorExtensions`.
 *
 * Only a single typed character counts. A paste of `**`, or an IME composing
 * several characters, is not a mark pressed over a selection and replaces it
 * as before.
 *
 * ## Why not `input.type`
 *
 * The change is tagged `input.wrap`. Autocompletion opens on `input.type`, and
 * `[[Ruth` with the caret after "Ruth" would otherwise open the note list over
 * words the person has just finished choosing — the opposite of asking.
 *
 * Nothing here touches React, react-native or the DOM: like `editorSetup.ts`,
 * it is compiled into the phone's guest bundle as well as the browser's.
 */

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Each mark that wraps a selection, and what closes it. */
export const WRAP_PAIRS: Readonly<Record<string, string>> = {
  "[": "]",
  "(": ")",
  "*": "*",
  _: "_",
  "=": "=",
  "~": "~",
  "`": "`",
};

export function wrapOnType() {
  return EditorView.inputHandler.of((view, _from, _to, text) => {
    const close = WRAP_PAIRS[text];
    const { state } = view;
    if (close === undefined || state.readOnly || state.selection.ranges.every((range) => range.empty)) return false;
    view.dispatch(
      state.update(
        state.changeByRange((range) => {
          if (range.empty) {
            return { changes: { from: range.from, insert: text }, range: EditorSelection.cursor(range.from + text.length) };
          }
          const shift = text.length;
          return {
            changes: [
              { from: range.from, insert: text },
              { from: range.to, insert: close },
            ],
            range: EditorSelection.range(range.anchor + shift, range.head + shift),
          };
        }),
        { scrollIntoView: true, userEvent: "input.wrap" },
      ),
    );
    return true;
  });
}
