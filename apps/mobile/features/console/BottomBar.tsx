import { useState, type JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { FocusRing } from "../design/components/FocusRing";
import { Text } from "../design/components/Text";
import { colors, layout, radii, space } from "../design/tokens";

/**
 * The compact toolbar: the verbs, within thumb reach.
 *
 * At `compact` the frame renders a `bottomBar` and **no** status bar — the
 * bottom edge is one or the other, never both (`features/app/frame.ts`). This
 * is what goes in that slot, and it is the phone's answer to everything a
 * pointer gets from a rail, a right-click menu and a keyboard chord. There is
 * no keyboard here and no hover: if a command is not on this strip, on a phone
 * it does not exist. That is why the shape is copied from Obsidian mobile —
 * back, forward, search, new, tab count, menu — rather than invented: it is the
 * arrangement the people most likely to arrive at this product already have
 * muscle memory for.
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
 *    whose targets are the size of their glyphs is a toolbar that fires the
 *    wrong command. The bar itself is taller than the minimum
 *    (`layout.bottomBarHeight`, 56) so every target clears it with room to
 *    spare, and the number is exported rather than typed twice so the test
 *    asserts the same constant the styles use.
 *
 *  - **The glyph is decorative; the name comes from `label`.** `☰`, `⌕` and `▤`
 *    are punctuation to a screen reader — announced as "trigram for heaven" or
 *    as nothing at all. A toolbar of unlabelled glyphs is unusable, and unlike
 *    the desktop there is no menu and no keymap to reach these commands by
 *    instead. So the glyphs are `aria-hidden` and `label` is mandatory, not
 *    optional-with-a-fallback: a fallback is how one ships unlabelled.
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
 * **It adds no safe-area padding.** `AppFrame` already applies `insets.bottom`
 * to the slot this renders into. Adding it here as well would double it, which
 * on a notched phone reads as a bar floating 68px above the home indicator, and
 * — because the frame is `100dvh` and clips — pushes the glyphs off the bottom
 * of the editor's space rather than growing the frame. If this component ever
 * gains padding at the bottom, it is a bug.
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
 * 44 is Apple's HIG minimum and Android's 48dp rounds down to about the same
 * physical size. Exported because the test asserts it: a rule enforced by a
 * number typed into a stylesheet and a different number typed into a test is a
 * rule that passes after somebody changes one of them.
 */
export const MIN_TOUCH_TARGET = 44;

export interface BottomBarAction {
  id: string;
  /**
   * The accessible name. Always present — see the file comment. It is a
   * sentence a person could act on ("Open the file tree"), not a noun, because
   * it is the entire description of a control whose glyph says nothing.
   */
  label: string;
  glyph: string;
  /**
   * A short visible caption under the glyph — "Files", "Search".
   *
   * Distinct from `label`, which is the full accessible name ("Open the file
   * tree") and is often too long to draw. Optional, but strongly preferred:
   * this app ships no icon font, so the glyphs are Unicode characters whose
   * optical sizes are wildly inconsistent — measured in Chromium at 19px,
   * `☰` is 17px wide, `＋` is 19, and `⌕` is **10.6**, so a bare-glyph toolbar
   * reads as three buttons and a smudge. A caption normalises the visual
   * weight of the whole row, and it is what a tab bar on either platform does
   * anyway.
   */
  title?: string;
  onPress: () => void;
  /** A count badge, e.g. open tabs. `0` draws nothing, rather than "0". */
  badge?: number;
  /** A dot, e.g. unsaved changes. */
  marker?: boolean;
  disabled?: boolean;
}

export function BottomBar({ actions }: { actions: BottomBarAction[] }): JSX.Element {
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
  const { label, glyph, title, onPress, badge, marker, disabled = false } = action;
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
        <Text style={[styles.glyph, title !== undefined && styles.glyphWithTitle]} aria-hidden>
          {glyph}
        </Text>

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
        `aria-hidden`, like the glyph: `label` is already the accessible name,
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
      <FocusRing visible={focused && !disabled} radius={radii.md} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    // The height is the token, not a number typed in here: `frame.ts` reserves
    // this much room along the bottom edge and the two must agree.
    height: layout.bottomBarHeight,
    flexDirection: "row",
    alignItems: "stretch",
    paddingHorizontal: space.x1,
    // No `paddingBottom`. `AppFrame` applies `insets.bottom` to this slot; see
    // the file comment.
  },

  target: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
  targetPressed: { backgroundColor: colors.surface3 },
  /** Dimmed rather than hidden — the position is load-bearing. */
  targetDisabled: { opacity: 0.38 },

  /**
   * The glyph's own box, which the badge and the marker hang off. Without it
   * they would be positioned against the target, which is as wide as the screen
   * divided by the number of actions — so the badge would drift further from
   * its glyph on every phone that is not the one it was eyeballed on.
   */
  mark: {
    minWidth: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },

  glyph: {
    fontSize: 19,
    lineHeight: 22,
    color: colors.text2,
  },
  /** A caption underneath needs the glyph to give up a little height. */
  glyphWithTitle: { fontSize: 17, lineHeight: 19 },
  title: {
    fontSize: 10,
    lineHeight: 13,
    marginTop: 1,
    color: colors.muted,
    textAlign: "center",
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
