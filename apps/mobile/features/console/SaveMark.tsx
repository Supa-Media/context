import { Platform, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../design/components/Icon";
import { Pill } from "../design/components/Pill";
import { useColors } from "../design/theme";
import type { EditorState } from "./files/editor";
import { saveChip } from "./files/status";

/**
 * Whether what you have typed is in the bucket yet, in the top bar.
 *
 * **This is where the Save button went.** The console autosaves a couple of
 * seconds after typing stops (`autosave.ts`), and while that write was pending
 * the editor drew "Discard changes" and "Save" across the foot of the note —
 * two controls over somebody's own text for the whole time they were writing.
 * What a person wants during that second or two is reassurance, and
 * reassurance is a mark, not a button.
 *
 * **A mark, not a pill, for everything that needs nothing from you.** It was a
 * green "Saved" pill — the loudest object in the corner, saying the most
 * ordinary thing the console ever says, every second somebody was not typing.
 * Saved, saving and "saving soon" are now a cloud in the chrome's muted ink:
 * there when you look for it, invisible when you do not, and its sentence on
 * hover and in its accessible name. The states split by whether a person has
 * to notice:
 *
 *  - **Nothing owed** — saved, saving, a draft about to be written — the bare
 *    cloud. A check once it is in the bucket, an arrow while it is going up.
 *  - **Worth noticing** — a queued draft, a body read off this device — the
 *    cloud gains its word, in `warn`, because both persist without the bucket
 *    hearing about them.
 *  - **A decision owed** — a save that failed, a conflict — a `crit` pill with
 *    the word, and `NoteEditor` still draws its row of buttons, because
 *    `editor.ts` keeps the manual route reachable exactly where autosave
 *    refuses.
 *
 * `saveChip` still supplies the words and the tone, so the strings, the
 * detail sentences and their tests are unchanged; only the drawing moved.
 *
 * **`local`** is the homepage's visitor, whose edits are kept in their browser
 * and never reach a bucket. "Saved to your bucket" would be false there, so
 * the resting mark is the device instead and says "Only on this device".
 *
 * **Leading the trailing group**: this is the only thing in the bar whose
 * width changes while somebody types, and in a row aligned to the trailing
 * edge the leading item is the one that can grow without moving the others.
 */
export function SaveMark({ editor, local = false }: { editor: EditorState; local?: boolean }) {
  const colors = useColors();
  const chip = saveChip({ editor, now: Date.now() });
  if (chip === null) return null;

  const label = saveMarkLabel(chip.text, chip.detail, { local, quiet: isQuiet(chip.tone) });
  /*
    The sentence behind the mark, the way `StatusBarSegment` carries it:
    RN-Web forwards `title` to the DOM node. Native has no hover, and gets the
    same words as the accessible name.
  */
  const tip = Platform.OS === "web" ? ({ title: label } as object) : null;
  const icon = saveMarkIcon(editor, local);

  if (isQuiet(chip.tone)) {
    return (
      <View
        accessible
        accessibilityLabel={label}
        testID="save-mark"
       
        style={styles.mark}
        {...tip}
      >
        <Icon name={icon} size={16} color={colors.chromeMuted} />
      </View>
    );
  }

  const tone = chip.tone === "crit" ? "crit" : "warn";
  return (
    <View accessible accessibilityLabel={label} testID="save-mark" {...tip}>
      <Pill
        tone={tone}
        style={styles.loud}
        leading={
          <Icon
            name={icon}
            size={14}
            color={tone === "crit" ? colors.critText : colors.warnText}
          />
        }
      >
        {chip.text}
      </Pill>
    </View>
  );
}

/** Saved, saving and "saving soon" arrive `quiet` or `ok`; they owe nothing. */
function isQuiet(tone: string): boolean {
  return tone === "quiet" || tone === "ok";
}

/**
 * The glyph for a state. `info` for the two that owe a decision — the same
 * mark the console uses wherever something needs reading — and a cloud for
 * the rest, because every one of them is a claim about the bucket.
 */
export function saveMarkIcon(editor: EditorState, local: boolean): IconName {
  switch (editor.status) {
    case "error":
    case "conflict":
      return "info";
    case "queued":
    case "dirty":
    case "saving":
      return "cloudUp";
    case "clean":
      if (editor.fromCache === true) return "cloudOff";
      return local ? "laptop" : "cloudCheck";
    default:
      return local ? "laptop" : "cloudCheck";
  }
}

/**
 * The mark's words, for its tooltip and its accessible name.
 *
 * A bare cloud has no text of its own, so "Saved" alone would leave a screen
 * reader — and a hover — with less than the pill used to say. The resting
 * claim names where it is saved; the detail follows when it adds something
 * rather than repeating the headline ("Saved." after "Saved").
 */
export function saveMarkLabel(
  text: string,
  detail: string | undefined,
  { local, quiet }: { local: boolean; quiet: boolean },
): string {
  let headline = text;
  if (quiet && /^Saved\b/.test(text)) {
    headline = local
      ? "Only on this device"
      : text.replace(/^Saved/, "Saved to your bucket");
  }
  if (detail === undefined || detail === "" || local) return headline;
  if (detail.replace(/\.$/, "").toLowerCase() === text.toLowerCase()) return headline;
  return `${headline}. ${detail}`;
}

const styles = StyleSheet.create({
  /** The same 28pt square as the bar's icon buttons, so it sits on their line. */
  mark: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  loud: { alignSelf: "center" },
});
