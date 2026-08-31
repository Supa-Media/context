import { useState, type JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon, type IconName } from "../../design/components/Icon";
import { KeyboardSticky, dismissKeyboard } from "../../design/keyboardSticky";
import { layout, radii, space } from "../../design/tokens";
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
 * ## Two keys the reference has that this deliberately does not
 *
 * Obsidian's row is undo, redo, `[ ]`, a page mark, **tag**, **attach**, H, B,
 * I. Ours drops tag and attach, and this is the sentence that says so on
 * purpose rather than leaving the next reader to think they were forgotten.
 *
 * Context has **no tag model** — nothing indexes `#tag`, nothing lists tags,
 * nothing searches by one — and **no attachment upload from the console**:
 * files reach a bucket through the gateway, Obsidian's own sync, or rclone, and
 * there is no picker in this app that puts one there. A key that inserts a `#`
 * nothing will ever read, or a paperclip that opens nothing, is a control that
 * is present and does nothing, which is the defect this codebase keeps
 * recording against itself. The bar is what ships, and the bar tells the truth.
 *
 * The page/file mark goes for a related reason — it is Obsidian's wikilink key,
 * and the `[ ]` beside it already covers the one bracket pair that means
 * something here. `brackets` therefore draws the **task checkbox**, which is
 * the one thing on this list a person writing notes in a hurry actually reaches
 * for.
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
  icon: IconName;
  run: (controls: EditorControls) => void;
}

/**
 * The editing keys, in the reference's order, minus the two the product cannot
 * back (see the file comment).
 *
 * A module-level list rather than JSX built inline: it is the answer to "what
 * does this bar do", and it reads as one.
 */
const KEYS: readonly AccessoryKey[] = [
  { id: "undo", label: "Undo", icon: "undo", run: (c) => c.undo() },
  { id: "redo", label: "Redo", icon: "redo", run: (c) => c.redo() },
  {
    id: "task",
    label: "Task checkbox",
    icon: "brackets",
    run: (c) => c.toggleLinePrefix("- [ ] "),
  },
  { id: "heading", label: "Heading", icon: "heading", run: (c) => c.toggleLinePrefix("# ") },
  { id: "bold", label: "Bold", icon: "bold", run: (c) => c.wrap("**", "**") },
  { id: "italic", label: "Italic", icon: "italic", run: (c) => c.wrap("*", "*") },
];

export function NoteAccessory({
  /**
   * Read at press time rather than held, because the editor hands its handle
   * over after this bar can already be on screen and takes it back on unmount.
   * A captured `EditorControls | null` would be `null` for the life of the bar
   * in the first case and a destroyed editor in the second.
   */
  controls,
}: {
  controls: () => EditorControls | null;
}): JSX.Element {
  const styles = useThemedStyles(makeStyles);

  return (
    <KeyboardSticky style={styles.sticky}>
      <View style={styles.row} testID="note-accessory">
        <View style={styles.pill} role="toolbar" aria-label="Formatting">
          {KEYS.map((key) => (
            <AccessoryButton
              key={key.id}
              id={key.id}
              label={key.label}
              icon={key.icon}
              onPress={() => {
                const api = controls();
                if (api !== null) key.run(api);
              }}
            />
          ))}
        </View>

        {/*
          Its own object, after a gap. See the file comment: this is the only
          key here that acts on the keyboard rather than on the note, and the
          reference separates it for that reason.

          Both halves, in this order. `blur()` releases the editing surface —
          which is what actually dismisses the keyboard on web, where there is
          no API for the keyboard itself, and which crosses the bridge as the
          one command a read-only note still accepts — and `dismissKeyboard()`
          is the native call that animates it away. Blurring alone leaves an iOS
          keyboard up when something else on screen still wants first responder;
          dismissing alone leaves the caret in the note, so the next tap
          anywhere brings the keyboard straight back.
        */}
        <View style={styles.dismiss}>
          <AccessoryButton
            id="dismiss"
            label="Hide the keyboard"
            icon="keyboardHide"
            onPress={() => {
              controls()?.blur();
              dismissKeyboard();
            }}
          />
        </View>
      </View>
    </KeyboardSticky>
  );
}

function AccessoryButton({
  id,
  label,
  icon,
  onPress,
}: {
  id: string;
  label: string;
  icon: IconName;
  onPress: () => void;
}): JSX.Element {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.target, pressed && styles.targetPressed]}
      testID={`note-accessory-${id}`}
    >
      <Icon name={icon} size={20} color={colors.text2} />
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
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  /**
   * The dismiss key's own object: a rounded square rather than a capsule,
   * which is what `radii.control` is for on a phone.
   *
   * `flexShrink: 0` so a narrow screen squeezes the editing keys rather than
   * this one. This is the only route out of the keyboard on this surface — see
   * the file comment — so it is the one control that must not be the one that
   * gets clipped.
   */
  dismiss: {
    flexGrow: 0,
    flexShrink: 0,
    width: layout.chromeButton,
    height: layout.minTouchTarget,
    borderRadius: radii.control,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

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
