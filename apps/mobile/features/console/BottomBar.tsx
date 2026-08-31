import { useState, type JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { FocusRing } from "../design/components/FocusRing";
import { Icon, type IconName } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { layout, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";

/**
 * The compact toolbar: the verbs, within thumb reach.
 *
 * At `compact` the frame renders a `bottomBar` and **no** status bar — the
 * bottom edge is one or the other, never both (`features/app/frame.ts`). This
 * is what goes in that slot: the phone's answer to the right-click menu and the
 * keyboard chord. **Navigation is not its job** — the top bar's switcher pulls
 * the rail in as a sheet, and that is where the app-level panes, the other
 * contexts and sign-out live (`features/app/frame.ts`). There is no keyboard
 * here and no hover: if a *verb* is not on this strip, on a phone it does not
 * exist. That is why the shape is copied from Obsidian mobile — back, forward,
 * search, new, tab count, menu — rather than invented: it is the arrangement
 * the people most likely to arrive at this product already have muscle memory
 * for.
 *
 * ## It is a pill lying on the note, not a bar ruled off from it
 *
 * The shape was copied and the *drawing* was not: this was a full-bleed strip
 * with a hairline along its top and a fill behind it, which is a desktop status
 * bar in a phone's position. Obsidian's is an object — inset from all three
 * edges, fully rounded, with a shadow under it — and that difference is most of
 * what makes one look like a phone application and the other like a window
 * that got narrow.
 *
 * The first pass at that inset it from the edges by ten points, which is a
 * 420pt plank on a 440pt screen: near enough to the full width that it still
 * reads as an edge, just one with rounded corners. Measured off the reference,
 * Obsidian's is about 315pt on the same screen — the controls at their own
 * size, centred, with the note showing either side. So the bar is sized by its
 * contents (`alignSelf: "center"`) rather than by a margin, and the gap either
 * side is whatever is left.
 *
 * That is deliberately **not** the flush, hairline-topped bar an earlier plan
 * called for. The reference is unambiguous on this point — reading view and
 * editing view both show a floating rounded pill with a shadow, well clear of
 * the screen edges — and where a written instruction and the screenshot
 * disagree, the screenshot is the specification.
 *
 * The frame still *reserves* the room (`AppFrame`'s `bottomBar` slot, plus
 * `layout.floatingInset` twice) rather than letting the document run beneath
 * it. Obsidian overlays and pays for it with bottom padding inside its
 * scroller; four different things land in this slot here — a note, a folder
 * listing, a settings document, a map — so overlaying would mean getting that
 * padding right in four places instead of once.
 *
 * ## Why this component knows nothing
 *
 * It takes a list of actions and draws them. It does not import the console's
 * data, the tab model or the frame, which is what lets it be mounted in a test
 * without a Convex subscription behind it — and, more importantly, what stops a
 * second copy of any rule living here. Whether a command is available, what it
 * does, and what it is called are decided by whoever builds the list; the only
 * thing decided in this file is that the result is reachable by a thumb.
 *
 * ## Three rules, each of which is a bug if it is broken
 *
 *  - **Every target is at least `MIN_TOUCH_TARGET` on both axes.** This is the
 *    one strip of the phone layout a thumb must hit reliably, and a toolbar
 *    whose targets are the size of their icons is a toolbar that fires the
 *    wrong command. The bar itself is taller than the minimum
 *    (`layout.bottomBarHeight`, 56) so every target clears it with room to
 *    spare, and the number is exported rather than typed twice so the test
 *    asserts the same constant the styles use.
 *
 *  - **The icon is decorative; the name comes from `label`.** An icon carries
 *    nothing to a screen reader, and unlike the desktop there is no menu and no
 *    keymap to reach these commands by instead. So `Icon` is `aria-hidden` and
 *    `label` is mandatory, not optional-with-a-fallback: a fallback is how one
 *    ships unlabelled.
 *
 *  - **A disabled action is dimmed, not removed.** The positions on this bar
 *    are fixed, and people aim at them by position long before they read them.
 *    An item that vanishes when it is unavailable moves every item to its right
 *    under a thumb already travelling, so "back is greyed out" becomes "I just
 *    deleted a note". It stays in the tree, keeps its label, and says it is
 *    disabled.
 *
 * ## Two things this deliberately does not do
 *
 * **It sets nothing on its bottom edge.** `AppFrame` owns that edge: it applies
 * `max(insets.bottom, floatingInset)` to the slot this renders into, so the
 * pill clears the home indicator on a notched phone and still has a gap on one
 * without. Setting anything here as well would stack, which is a bar floating
 * 68px above the home indicator, and — because the frame is `100dvh` and clips
 * — pushes the icons off the bottom of the editor's space rather than growing
 * the frame. The inset either side is a `marginHorizontal` for the same reason
 * in reverse: nothing else is deciding the horizontal edges. If this component
 * ever gains a bottom margin or padding, it is a bug.
 *
 * **It does not reimplement the tab count.** `TabCountButton` in
 * `files/TabSwitcher.tsx` already owns the count square, its unsaved dot and
 * the phrasing a screen reader hears ("2 notes open, 1 with unsaved changes"),
 * and it opens the switcher sheet. Where the count belongs on this bar, that
 * phrasing is what goes in `label` and `badge`/`marker` carry the visuals — the
 * numbers stay one implementation in `tabs.ts` (`dirtyCount`), presented twice,
 * rather than two implementations that can disagree about how many notes are
 * open.
 */

/**
 * The smallest target a thumb can be asked to hit, in points.
 *
 * Exported because the test asserts it: a rule enforced by a number typed into
 * a stylesheet and a different number typed into a test is a rule that passes
 * after somebody changes one of them.
 *
 * The number itself lives in `design/tokens` — it governs every control a phone
 * offers, not only this bar, and the frame's own navigation control is held to
 * it too.
 */
export const MIN_TOUCH_TARGET = layout.minTouchTarget;

export interface BottomBarAction {
  id: string;
  /**
   * The accessible name. Always present — see the file comment. It is a
   * sentence a person could act on ("Open the file tree"), not a noun, because
   * it is the entire description of a control whose icon says nothing.
   */
  label: string;
  icon: IconName;
  /**
   * A short visible caption under the icon — "Files", "Search".
   *
   * Distinct from `label`, which is the full accessible name ("Open the file
   * tree") and is often too long to draw.
   *
   * **This used to be strongly preferred and is now the exception.** The
   * argument for it was measured and specific: the app shipped no icon set, so
   * these were Unicode characters whose optical sizes are wildly inconsistent
   * — measured in Chromium at 19px, `☰` is 17px wide, `＋` is 19, and `⌕` is
   * **10.6** — and a bare-glyph toolbar "reads as three buttons and a smudge".
   * A caption normalised the row.
   *
   * `design/components/Icon` removes the cause: every icon is drawn in the same
   * box at the same stroke weight, so the row is even without captions. What is
   * left is the cost — a caption is a second line of 10px type under a control
   * whose name a screen reader already has, and a toolbar of five of them is
   * the thing that reads as a 2011 tab bar. Obsidian's carries none. Keep this
   * for a control whose icon genuinely cannot say which of two similar things
   * it is; do not put one under every button again.
   */
  title?: string;
  onPress: () => void;
  /** A count badge, e.g. open tabs. `0` draws nothing, rather than "0". */
  badge?: number;
  /**
   * A count drawn **as** the control, inside an outlined box, in place of the
   * icon.
   *
   * Obsidian's tab control on mobile is exactly this: a rounded square with the
   * number of open notes inside it, and no icon at all. Ours was a document
   * icon with a filled accent badge stuck on its corner, which reads as a
   * notification — something has happened that you should attend to — rather
   * than as a count of things you already have open. The number is the whole
   * message, so it is the whole control.
   *
   * `icon` is still required and still the accessible fallback; nothing draws
   * it while a count is present.
   */
  count?: number;
  /** A dot, e.g. unsaved changes. */
  marker?: boolean;
  disabled?: boolean;
}

export function BottomBar({ actions }: { actions: BottomBarAction[] }): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.bar} role="toolbar" aria-label="Console actions" testID="bottom-bar">
      {actions.map((action) => (
        <BottomBarButton key={action.id} action={action} />
      ))}
    </View>
  );
}

/**
 * One target.
 *
 * `flex: 1` with a floor of `MIN_TOUCH_TARGET` is what "evenly distributed"
 * means here: the targets share the width equally, and if there are ever enough
 * of them that an equal share would fall below the floor, they stop shrinking
 * instead — an overflowing toolbar is a visible problem, and a row of 30pt
 * targets is an invisible one.
 */
function BottomBarButton({ action }: { action: BottomBarAction }): JSX.Element {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { label, icon, title, onPress, badge, count, marker, disabled = false } = action;
  const [focused, setFocused] = useState(false);
  const showBadge = badge !== undefined && badge > 0;

  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      // Written as an ARIA attribute rather than through `accessibilityState`.
      // react-native-web 0.21 dropped the mapping for parts of that prop — the
      // codebase has already been bitten once by `accessibilityState.selected`
      // rendering *nothing*, silently — and the disabled state of a control
      // that stays on screen precisely so it can be announced is not something
      // to leave to a mapping that may or may not still exist.
      aria-disabled={disabled || undefined}
      // The refusal itself is `Pressable`'s: a press on a disabled control must
      // not reach `onPress`, and dimming without that is a control that looks
      // unavailable and fires anyway.
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.target,
        pressed && !disabled && styles.targetPressed,
        disabled && styles.targetDisabled,
      ]}
      testID={`bottom-bar-${action.id}`}
    >
      <View style={styles.mark}>
        {count === undefined ? (
          <Icon name={icon} size={title === undefined ? 22 : 20} color={colors.text2} />
        ) : (
          <View style={styles.count} aria-hidden testID={`bottom-bar-${action.id}-count`}>
            <Text style={styles.countLabel}>{count}</Text>
          </View>
        )}

        {/*
          The badge sits on the trailing top corner and the marker on the
          leading one, so an action carrying both — the tab count with unsaved
          work, which is the case this exists for — draws them side by side
          rather than one on top of the other.
        */}
        {showBadge ? (
          <View style={styles.badge} aria-hidden testID={`bottom-bar-${action.id}-badge`}>
            <Text style={styles.badgeLabel}>{badge}</Text>
          </View>
        ) : null}

        {marker ? (
          <View style={styles.marker} aria-hidden testID={`bottom-bar-${action.id}-marker`} />
        ) : null}
      </View>

      {/*
        `aria-hidden`, like the icon: `label` is already the accessible name,
        and announcing "Search, Search notes" is worse than announcing neither.
        This caption is for eyes.
      */}
      {title !== undefined ? (
        <Text
          style={styles.title}
          numberOfLines={1}
          aria-hidden
          testID={`bottom-bar-${action.id}-title`}
        >
          {title}
        </Text>
      ) : null}

      {/* Web is a first-class surface: this bar is reachable by Tab there. */}
      <FocusRing visible={focused && !disabled} radius={radii.control} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  bar: {
    // The height is the token, not a number typed in here: `frame.ts` reserves
    // this much room along the bottom edge and the two must agree.
    height: layout.bottomBarHeight,
    flexDirection: "row",
    alignItems: "stretch",
    paddingHorizontal: space.x2,
    /*
      It is as wide as what is on it, and centred — not a slab across the glass.

      This used to stretch to the full width minus `floatingInset`, which on a
      440pt screen is a 420pt white plank with six icons spread across it: an
      object so nearly the width of its container that it reads as an *edge*
      with rounded corners rather than as something lying on the note. Measured
      off the reference, Obsidian's is about 315pt on the same screen — six
      controls at their own size, centred, with the note visible either side of
      it. That gap is most of what makes one look like it is floating.

      Nothing horizontal is set at all now: `alignSelf: "center"` sizes the bar
      to its content, so the inset either side is whatever is left over, and
      there is no number to keep in step with the number of actions on the bar.
      The bottom edge still belongs to `AppFrame`, which is the one that knows
      the safe-area inset; see the file comment.
    */
    alignSelf: "center",
    maxWidth: "100%",
    borderRadius: radii.floating,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  /**
   * One target, at its own size rather than at a share of the screen.
   *
   * `flex: 1` was what "evenly distributed" meant while the bar was full
   * width. A content-width bar distributes them by giving each the same fixed
   * box, which is the same evenness with none of the dependence on how wide the
   * phone is — and it is what lets the bar itself be as wide as what is on it.
   * The floor is still the floor: this *is* `MIN_TOUCH_TARGET` on both axes,
   * and the bar is taller again so every target clears it with room to spare.
   */
  target: {
    flexGrow: 0,
    flexShrink: 0,
    width: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
  },
  targetPressed: { backgroundColor: colors.chromePressed },
  /** Dimmed rather than hidden — the position is load-bearing. */
  targetDisabled: { opacity: 0.38 },

  /**
   * The icon's own box, which the badge and the marker hang off. Without it
   * they would be positioned against the target, which is as wide as the screen
   * divided by the number of actions — so the badge would drift further from
   * its icon on every phone that is not the one it was eyeballed on.
   */
  mark: {
    minWidth: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },

  title: {
    fontSize: 10,
    lineHeight: 13,
    marginTop: 1,
    color: colors.muted,
    textAlign: "center",
  },

  /**
   * The tab count, drawn as Obsidian draws it: an outlined rounded square with
   * the number inside. Sized so the box is the same optical weight as the
   * monoline icons beside it rather than a filled chip competing with them.
   */
  count: {
    minWidth: 21,
    height: 21,
    paddingHorizontal: 3,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.xs,
    borderWidth: 1.5,
    borderColor: colors.text2,
  },

  countLabel: {
    fontSize: 11.5,
    lineHeight: 14,
    fontWeight: "600",
    color: colors.text2,
    fontVariant: ["tabular-nums"],
  },

  badge: {
    position: "absolute",
    top: -3,
    right: -9,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },

  badgeLabel: {
    fontSize: 10.5,
    lineHeight: 13,
    fontWeight: "700",
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },

  marker: {
    position: "absolute",
    top: -1,
    left: -7,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
