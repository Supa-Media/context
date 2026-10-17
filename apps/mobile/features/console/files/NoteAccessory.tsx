import { useState, type JSX } from "react";
import { Platform, Pressable, StyleSheet, View, type ViewProps } from "react-native";
import { FocusRing } from "../../design/components/FocusRing";
import { Text } from "../../design/components/Text";
import { Icon, type IconName } from "../../design/components/Icon";
import { KeyboardSticky, dismissKeyboard } from "../../design/keyboardSticky";
import { fonts, layout, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { ACCESSORY_GAP } from "./accessory";
import type { EditorControls } from "./LiveEditor";

/**
 * The keyboard accessory bar: the row that rides above the soft keyboard while
 * a note is being edited on a phone.
 *
 * ## The complaint this answers, in the owner's words: "it is impossible to
 * dismiss the keyboard"
 *
 * On a phone the note *is* the screen, so opening the keyboard covers half of
 * it and there was no route back. Not a small annoyance — the bottom bar is
 * behind the keyboard, so while the keyboard is up the app has no controls at
 * all. Obsidian's answer is this bar, and the rightmost key on it is the way
 * out; everything else on it is there because a bar with one key on it looks
 * like an apology.
 *
 * **It is now the only route out of the keyboard, and that is load-bearing.**
 * The note is a `WebView` whose outer scroll view is deliberately off, so
 * CodeMirror's own scroller is the only one — and `keyboardDismissMode` is a
 * `ScrollView` prop implemented by `RCTScrollView`, so drag-to-dismiss cannot
 * exist on this surface. See the long comment on `scrollEnabled` in
 * `LiveEditor.tsx`. That is why the dismiss key gets its own object that cannot
 * be the one clipped on a narrow screen, and why `blur` is the one command
 * `acceptsCommand` never refuses.
 *
 * ## Drawn from the reference, which is the specification
 *
 * Measured off a 1320x2868 screenshot (440x956pt at @3x), Obsidian's is **two
 * objects, not one**: a white pill carrying the editing keys, and — after a
 * visible gap of about 8pt — a separate, smaller white rounded square carrying
 * the dismiss key. Both are fully filled white with a soft shadow and **no
 * border**; the pale falloff at their edges is the shadow. That separation is
 * not decoration: the dismiss key is the only control here that acts on the
 * *keyboard* rather than on the *note*, and a key that leaves the editing
 * surface alone should not sit in the same object as the ones that do not.
 *
 * The same three drawing rules as `BottomBar`, for the same reasons: white
 * fill, no border, `radii.pill` on the capsule so the corner radius is half its
 * height rather than a rectangle wearing a pill's radius.
 *
 * ## Two keys the reference has that this deliberately does not, and one it
 * has again
 *
 * Obsidian's row is undo, redo, `[ ]`, a page mark, **tag**, **attach**, H, B,
 * I. Ours drops tag and attach, and this is the sentence that says so on
 * purpose rather than leaving the next reader to think they were forgotten.
 * The page mark is back, as `link`, and the paragraph after the next one says
 * why.
 *
 * Context has **no tag model** — nothing indexes `#tag`, nothing lists tags,
 * nothing searches by one — and **no attachment upload from the console**:
 * files reach a bucket through the gateway, Obsidian's own sync, or rclone, and
 * there is no picker in this app that puts one there. A key that inserts a `#`
 * nothing will ever read, or a paperclip that opens nothing, is a control that
 * is present and does nothing, which is the defect this codebase keeps
 * recording against itself. The bar is what ships, and the bar tells the truth.
 *
 * The page/file mark — Obsidian's wikilink key — went for a related reason,
 * argued here at the time: `[ ]` already covered the one bracket pair that
 * meant something here, because a bare `[[name]]` did nothing at all. That
 * argument is reversed now, and the reversal is `link` below, not deleted from
 * this file: see `docs/decisions/app-and-console.md`, "A link key on the
 * accessory bar", for what changed underneath it (**L1**'s note-path index,
 * **L3**'s touch-followable underline) and why the bracket-pair objection was
 * never actually an objection to a *second* key. `brackets` still draws the
 * task checkbox, which stays the one thing on this list from that era a person
 * writing notes in a hurry reaches for most.
 *
 * ## Where it sits
 *
 * `KeyboardSticky` anchors this to the bottom of whatever contains it and, on
 * native, translates it upward by the keyboard's height in step with the
 * keyboard's own animation. Its container is `NoteEditor`'s root, so it rests
 * on the top edge of the keyboard with `ACCESSORY_GAP` of air under it.
 *
 * The frame's own bottom toolbar is behind the keyboard while this is up, so
 * the two do not collide today. When the frame grows a way to be told a bar is
 * on screen — `setAccessoryOpen` on the branch that owns `AppFrame` — this
 * should tell it, and take that branch's `chromeGap` for its own padding so the
 * two objects land in the same place rather than 25pt apart.
 */

interface AccessoryKey {
  id: string;
  /**
   * The accessible name, and the only name this control has. An icon carries
   * nothing to a screen reader, and unlike the desktop there is no menu and no
   * keymap here to reach these commands by instead — `BottomBar`'s rule, and
   * for a bar with even less room for a caption.
   */
  label: string;
  icon: IconName | { text: string; style: "bold" | "italic" | "strike" | "plain" };
  run: (controls: EditorControls, askLink: ((words: string) => void) | undefined) => void;
}

/*
  FOUR KEYS AND DONE, AND ONE Aa FOR THE REST (phone writing board,
  2026-10-17, approved by Dev2: "LETS DO IT, make sure the app looks EXACTLY
  like the mockups").

  The bar was nine equal keys in Obsidian's order — undo, redo, `[ ]`, list,
  link, H, B, I, then hide-the-keyboard — and the leadership weekly said
  writing on the phone was still tough. A phone note is mostly lines, lists
  and checklists, so the bar keeps what a thumb reaches for in a hurry: a
  checklist, a list, Aa, the microphone, and Done. Everything else folds
  behind Aa, the way Apple Notes does it: Title / Heading / Body, B I S and
  link, the two lists and the checklist, undo and redo. Nothing the bar
  could do before is gone; it is one press further.
*/

/** The bar itself: what a thumb reaches for while writing. */
const BAR_KEYS: readonly AccessoryKey[] = [
  { id: "task", label: "Checklist", icon: "checkCircle", run: (c) => c.toggleLinePrefix("- [ ] ") },
  { id: "bullet", label: "Bulleted list", icon: "bulletList", run: (c) => c.toggleLinePrefix("- ") },
];

/** The Aa panel, row by row, as board 3 draws it. */
const STYLE_KEYS: readonly AccessoryKey[] = [
  { id: "title", label: "Title", icon: { text: "Title", style: "bold" }, run: (c) => c.lineStyle("# ") },
  { id: "heading", label: "Heading", icon: { text: "Heading", style: "plain" }, run: (c) => c.lineStyle("## ") },
  { id: "body", label: "Body", icon: { text: "Body", style: "plain" }, run: (c) => c.lineStyle("") },
];
const MARK_KEYS: readonly AccessoryKey[] = [
  { id: "bold", label: "Bold", icon: { text: "B", style: "bold" }, run: (c) => c.wrap("**", "**") },
  { id: "italic", label: "Italic", icon: { text: "I", style: "italic" }, run: (c) => c.wrap("*", "*") },
  { id: "strike", label: "Strikethrough", icon: { text: "S", style: "strike" }, run: (c) => c.wrap("~~", "~~") },
  /*
    With words selected, the editor saves them and calls `askLink`, and the
    Link sheet takes it from there (`LinkSheet.tsx`); with nothing selected it
    is still `[[]]` with completion. See "A link key on the accessory bar".
  */
  { id: "link", label: "Insert link", icon: "link", run: (c, askLink) => c.insertLink(askLink) },
];
const LIST_KEYS: readonly AccessoryKey[] = [
  { id: "list", label: "Bulleted list", icon: "bulletList", run: (c) => c.toggleLinePrefix("- ") },
  { id: "number", label: "Numbered list", icon: "numberList", run: (c) => c.toggleLinePrefix("1. ") },
  { id: "checklist", label: "Checklist", icon: "checkCircle", run: (c) => c.toggleLinePrefix("- [ ] ") },
  { id: "undo", label: "Undo", icon: "undo", run: (c) => c.undo() },
  { id: "redo", label: "Redo", icon: "redo", run: (c) => c.redo() },
];

/**
 * A press on the bar leaves the caret in the note.
 *
 * On web a key is a focusable button, so the mousedown under a press moves
 * focus onto it: the note reports a blur, the bar (which only shows while the
 * note has focus) goes away under the finger, and Aa — the one key that sends
 * no command to bring the caret back — could never open its panel. Refusing
 * the mousedown's default keeps focus where it was; the press still lands.
 * React Native Web forwards `onMouseDown` from a `View` (see `TabStrip.tsx`).
 */
const KEEP_CARET: ViewProps =
  Platform.OS === "web"
    ? ({ onMouseDown: (event: { preventDefault?: () => void }) => event.preventDefault?.() } as unknown as ViewProps)
    : {};

export function NoteAccessory({
  /**
   * Read at press time rather than held, because the editor hands its handle
   * over after this bar can already be on screen and takes it back on unmount.
   * A captured `EditorControls | null` would be `null` for the life of the bar
   * in the first case and a destroyed editor in the second.
   */
  controls,
  onAskLink,
  onDictate,
}: {
  controls: () => EditorControls | null;
  /** Show the Link sheet over these selected words. Absent: no sheet here. */
  onAskLink?: (words: string) => void;
  /** Start dictating at the caret (`VoiceButton`'s `startDictation`). Absent: no microphone key. */
  onDictate?: () => void;
}): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [formatting, setFormatting] = useState(false);
  const run = (key: AccessoryKey) => () => {
    const api = controls();
    if (api !== null) key.run(api, onAskLink);
  };
  const keys = (row: readonly AccessoryKey[], style: object) =>
    row.map((key) => (
      <AccessoryButton key={key.id} id={key.id} label={key.label} icon={key.icon} onPress={run(key)} style={style} />
    ));

  return (
    <KeyboardSticky style={styles.sticky}>
      <View style={styles.row} testID="note-accessory" {...KEEP_CARET}>
        <View style={styles.pill} role="toolbar" aria-label="Writing">
          {keys(BAR_KEYS, styles.target)}
          <AccessoryButton
            id="format"
            label={formatting ? "Hide formatting" : "Formatting"}
            icon={{ text: "Aa", style: "plain" }}
            onPress={() => setFormatting((open) => !open)}
            style={styles.target}
            on={formatting}
          />
          {onDictate === undefined ? null : (
            <AccessoryButton id="mic" label="Dictate" icon="mic" onPress={onDictate} style={styles.target} />
          )}
        </View>

        {/*
          Done: its own object, after a gap, and the one filled key. See the
          file comment: this is the only key here that acts on the keyboard
          rather than on the note, and it is the way out of the keyboard.

          Both halves, in this order. `blur()` releases the editing surface —
          which is what actually dismisses the keyboard on web, where there is
          no API for the keyboard itself, and which crosses the bridge as the
          one command a read-only note still accepts — and `dismissKeyboard()`
          is the native call that animates it away. Blurring alone leaves an iOS
          keyboard up when something else on screen still wants first responder;
          dismissing alone leaves the caret in the note, so the next tap
          anywhere brings the keyboard straight back.
        */}
        <Pressable
          role="button"
          accessibilityLabel="Done"
          accessibilityHint="Hides the keyboard"
          onPress={() => {
            setFormatting(false);
            controls()?.blur();
            dismissKeyboard();
          }}
          style={({ pressed }) => [styles.done, pressed && styles.donePressed]}
          testID="note-accessory-dismiss"
        >
          <Text style={[styles.doneLabel, { color: colors.ink }]}>Done</Text>
        </Pressable>
      </View>

      {formatting ? (
        <View style={styles.panel} role="toolbar" aria-label="Formatting" testID="note-accessory-panel" {...KEEP_CARET}>
          <View style={styles.panelRow}>{keys(STYLE_KEYS, styles.panelKey)}</View>
          <View style={styles.panelRow}>{keys(MARK_KEYS, styles.panelKey)}</View>
          <View style={styles.panelRow}>{keys(LIST_KEYS, styles.panelKey)}</View>
        </View>
      ) : null}
    </KeyboardSticky>
  );
}

function AccessoryButton({
  id,
  label,
  icon,
  onPress,
  style,
  on = false,
}: {
  id: string;
  label: string;
  icon: AccessoryKey["icon"];
  onPress: () => void;
  style: object;
  on?: boolean;
}): JSX.Element {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const ink = on ? colors.ink : colors.text;

  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      aria-pressed={id === "format" ? on : undefined}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [style, pressed && !on && styles.targetPressed]}
      testID={`note-accessory-${id}`}
    >
      {/* Aa, while its panel is open, is a filled circle (board 3). */}
      <View style={[styles.face, on && styles.keyOn]}>
        {typeof icon === "string" ? (
          <Icon name={icon} size={20} color={ink} />
        ) : (
          <Text style={[styles.keyText, styles[icon.style], { color: ink }]}>{icon.text}</Text>
        )}
      </View>
      {/* Web is a first-class surface: this bar is reachable by Tab there. */}
      <FocusRing visible={focused} radius={radii.control} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  /**
   * The side inset and the air under the row. The bottom anchoring belongs to
   * `KeyboardSticky`, which owns it on both platforms so the two cannot end up
   * anchored differently — see that module.
   *
   * `paddingBottom` is `ACCESSORY_GAP`, and `accessory.ts` adds the same number
   * to the row's height when it tells the editor how much of the note is
   * covered. Read from there rather than typed here, because a gap that grew in
   * one of those two places is a caret sitting behind this bar.
   */
  sticky: {
    paddingHorizontal: layout.floatingInset,
    paddingBottom: ACCESSORY_GAP,
    /*
      Above the bottom toolbar, which it lands on top of. While the keyboard is
      up this row *is* the toolbar, which is what the reference shows. `2`
      rather than `1` because the frame's own chrome sits at `1`.
    */
    zIndex: 2,
  },

  row: { flexDirection: "row", alignItems: "center", gap: space.x2 },

  /**
   * The editing keys, in a capsule that takes the width left over.
   *
   * `flexGrow` rather than the content width `BottomBar` uses, and the
   * difference is measured rather than a preference: the bottom bar in the
   * reference is 336pt on a 440pt screen — an object lying on the note with the
   * note showing either side — while the accessory bar runs almost the whole
   * width, because the keyboard beneath it is full-bleed anyway. A
   * content-width accessory bar would read as a second bottom bar that had lost
   * some buttons.
   *
   * A full pill, not `radii.floating`: the reference's ends narrow
   * symmetrically, which is a corner radius of half the height. White fill,
   * soft shadow, no border.
   */
  pill: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "stretch",
    height: layout.minTouchTarget,
    paddingHorizontal: space.x2,
    borderRadius: radii.pill,
    // The phone's raised grey, as board 3 draws the bar (`cardSurface`).
    backgroundColor: colors.cardSurface,
    boxShadow: shadows.floating,
  },

  /**
   * Done: a filled accent capsule, the one filled key (board 3).
   *
   * `flexShrink: 0` so a narrow screen squeezes the editing keys rather than
   * this one. This is the only route out of the keyboard on this surface — see
   * the file comment — so it is the one control that must not be the one that
   * gets clipped.
   */
  done: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 76,
    height: layout.minTouchTarget,
    paddingHorizontal: space.x4,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    boxShadow: shadows.floating,
  },
  donePressed: { opacity: 0.8 },
  doneLabel: { fontFamily: fonts.body, fontSize: touchType.ui, fontWeight: "700" },

  /** Aa's panel, under the bar and over the keyboard: three rows of keys on the bar's own fill. */
  panel: {
    marginTop: space.x2,
    padding: space.x3,
    gap: space.x2,
    borderRadius: radii.sheet,
    backgroundColor: colors.cardSurface,
    boxShadow: shadows.floating,
  },
  panelRow: { flexDirection: "row", gap: space.x2 },
  panelKey: {
    flex: 1,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: colors.pageSurface,
  },
  face: { minWidth: 40, height: 40, paddingHorizontal: space.x1, alignItems: "center", justifyContent: "center", borderRadius: radii.pill },
  keyOn: { backgroundColor: colors.accent },
  keyText: { fontFamily: fonts.body, fontSize: touchType.lede, fontWeight: "600" },
  plain: {},
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic", fontFamily: "Georgia" },
  strike: { textDecorationLine: "line-through" },

  /**
   * One key.
   *
   * `flex: 1` with a floor of `minTouchTarget` is `BottomBar`'s rule and it is
   * the right one here too: the keys share the pill's width equally, and if
   * there are ever enough of them that an equal share would fall below the
   * floor they stop shrinking instead. An overflowing toolbar is a visible
   * problem; a row of 30pt targets is an invisible one.
   */
  target: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: layout.minTouchTarget,
    minHeight: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
  },
  targetPressed: { backgroundColor: colors.chromePressed },
});
