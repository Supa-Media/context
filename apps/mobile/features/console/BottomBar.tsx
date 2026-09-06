import { Fragment, useState, type JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { FocusRing } from "../design/components/FocusRing";
import { Icon, type IconName } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { layout, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";

/**
 * The compact toolbar: the verbs, within thumb reach.
 *
 * At `compact` the frame renders a `bottomBar` and **no** status bar — the
 * bottom edge is one or the other, never both (`features/app/frame.ts`). This
 * is what goes in that slot: the phone's answer to the right-click menu and the
 * keyboard chord. There is no keyboard here and no hover: if a *verb* is not on
 * this strip, on a phone it does not exist. That is why the shape is copied
 * from Obsidian mobile — back, forward, search, new, tab count, menu — rather
 * than invented: it is the arrangement the people most likely to arrive at this
 * product already have muscle memory for.
 *
 * ## "Navigation is not its job" is amended, and here is how far
 *
 * This file used to say that flatly, and gave its reason: the top bar's
 * switcher pulled the rail in as a sheet, and the rail was where the app-level
 * panes, the other contexts and sign-out lived. Both halves of that premise are
 * gone. There is no sheet and no rail on a phone at all
 * (`features/app/frame.ts`), the contexts moved to the context strip along the
 * top, and the app's other places had nowhere left to be reached from.
 *
 * So this bar takes **one** of them, and the boundary is worth stating exactly,
 * because a boundary this vague is one a later change walks through. It does
 * not carry the contexts: those are a list that grows as somebody joins
 * workspaces, and a list belongs on a strip that scrolls rather than on a row
 * whose whole value is that a thumb can aim at a fixed position without
 * looking. It carries one **destination**, in the last position, behind a
 * separator — so the note's verbs still read as a group and the seventh key
 * does not join it.
 *
 * **This file does not know what that destination is.** `separated` says where
 * the group ends and nothing here says what comes after it; which route the
 * last key opens is decided by whoever builds the list, exactly as every other
 * action here is. A toolbar that named a feature would be a second place that
 * feature's placement is decided, and the first one would stop being the only
 * one.
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
 * reads as an edge, just one with rounded corners. The reference, measured off
 * a 1320x2868 screenshot (440x956pt at @3x):
 *
 *   - x from 52.0pt to 387.7pt — **52pt of note showing on each side**, a bar
 *     336pt wide rather than 420;
 *   - y from about 865pt to 931pt — **66pt tall**, and about **25pt above the
 *     bottom of the glass**;
 *   - the extent narrows symmetrically at both ends (87.7→352 at the top edge,
 *     52→387.7 at the middle), which is a **full pill**: corner radius half the
 *     height, about 33pt, not a rounded rectangle;
 *   - white fill, no border. The pale falloff at the edges is a soft shadow.
 *
 * **The 52 is the measurement; the 336 is what follows from it.** The pass
 * before this had it the other way round — the bar was sized to its own targets
 * and the inset was whatever was left over — which made the gap depend on how
 * many actions the current route offers. On a context somebody was invited into
 * there is no New note, so five targets put the pill at 78→362: the same bar in
 * a different place on the screen, on a device where it is supposed to be in
 * one. `AppFrame` insets the slot by `layout.bottomBarInset` now and the bar
 * fills it; the targets divide what is inside.
 *
 * **And the inset is 24 rather than 52, which is what the seventh key cost.**
 * The measurement above is still the measurement; what changed is that the
 * sliver of note it buys is worth less than a destination. On a 390pt phone —
 * the narrow case, not the reference's 440 — seven targets inside a pill inset
 * by 52 are 37.4pt wide against a 44pt floor, and six are 43.7, which is under
 * it too. At 24 they are 45.29 — 317 divided seven ways, not 318, because the
 * separator is a child of the same row and takes its point off the targets.
 * `layout.bottomBarInset` carries the arithmetic and `bottomBar.test.ts`
 * recomputes both rows from the tokens rather than quoting either number.
 *
 * That is deliberately **not** the flush, hairline-topped bar an earlier plan
 * called for. The reference is unambiguous on this point — reading view and
 * editing view both show a floating rounded pill with a shadow, well clear of
 * all three edges — and where a written instruction and the screenshot
 * disagree, the screenshot is the specification.
 *
 * The frame still *reserves* the room (`AppFrame`'s `bottomBar` slot, plus
 * `layout.floatingInset` above and `layout.floatingGap` below) rather than
 * letting the document run beneath it. Obsidian overlays and pays for it with bottom padding inside its
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
 *    (`layout.bottomBarHeight`, 66) and each target is wider than it
 *    (`layout.bottomBarTarget`, 52), so every one clears the floor with room to
 *    spare; the floor is exported rather than typed twice so the test asserts
 *    the same constant the styles use.
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
 * **It sets nothing on its own edges.** `AppFrame` owns all four: it applies
 * `max(insets.bottom, floatingGap)` below and `layout.bottomBarInset` either
 * side of the slot this renders into, so the pill clears the home indicator on
 * a notched phone, still has the reference's 25pt gap on one without, and sits
 * 52pt in from each edge whatever is on it. Setting anything here as well would
 * stack, which is a bar floating 68px above the home indicator, and — because
 * the frame is `100dvh` and clips — pushes the icons off the bottom of the
 * editor's space rather than growing the frame. If this component ever gains a
 * margin or an outer padding of its own, it is a bug.
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
  /**
   * Draw a hairline immediately **before** this action.
   *
   * The row holds two kinds of thing that a person should not have to read the
   * icons to tell apart: verbs that act on the note in front of them, and — in
   * the last position — one destination that leaves it. Six of one and one of
   * the other, undivided, is a seven-icon row where the last one silently does
   * something categorically different from its neighbours.
   *
   * A rule is the cheapest possible answer: no gap (which would cost width the
   * targets need — see `bottomBarInset`'s arithmetic, where seven targets clear
   * 44pt by 1.29 on a 390pt phone, the rule's own point already deducted), no
   * heading, and nothing that has to be announced. It is
   * `aria-hidden`, because a screen reader is already told each control's whole
   * name and a decoration between two of them adds nothing but noise.
   *
   * Optional, and there is deliberately no "how many groups" model: this row is
   * seven items wide. One boundary is a rule; two would be a toolbar pretending
   * to be a menu bar.
   */
  separated?: boolean;
}

export function BottomBar({ actions }: { actions: BottomBarAction[] }): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.bar} role="toolbar" aria-label="Console actions" testID="bottom-bar">
      {actions.map((action, index) => (
        <Fragment key={action.id}>
          {/*
            A separator before the first action would be a rule against the
            pill's own leading edge, which is a mistake in a list somebody
            reordered rather than a boundary anybody meant. It is dropped
            rather than drawn, and the flag on the action is left alone — the
            caller said where its group ends and being first is not a
            disagreement with that, it is the same statement with nothing on
            the other side of it.
          */}
          {action.separated && index > 0 ? (
            <View style={styles.separator} aria-hidden testID="bottom-bar-separator" />
          ) : null}
          <BottomBarButton action={action} />
        </Fragment>
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
    paddingHorizontal: layout.bottomBarPad,
    /*
      An object lying on the note, not a slab across the glass.

      This used to stretch to the full width minus `floatingInset`, which on a
      440pt screen is a 420pt white plank with six icons spread across it: an
      object so nearly the width of its container that it reads as an *edge*
      with rounded corners rather than as something lying on the note. Measured
      off the reference, Obsidian's runs 52.0→387.7 on that screen — 336pt, with
      52pt of note showing on each side. That gap is most of what makes one look
      like it is floating, and it is now `layout.bottomBarInset`, spent by the
      frame on the slot this renders into.

      Both edges belong to `AppFrame` for the same reason: it is the one that
      knows the safe-area inset. See the file comment.
    */
    /*
      It fills the slot the frame insets for it, rather than sizing itself.

      `alignSelf: "center"` with a content width was the first answer, and it
      was right about the *look* and wrong about where the number comes from:
      the inset either side became a function of how many actions the route has
      — six on your own context, five on one you were invited into, because
      there is no New note — so the bar sat 52pt in on one screen and 78 on the
      next. The reference's 52 is a property of the screen, not of the toolbar's
      contents. `AppFrame` insets the slot by `layout.bottomBarInset` and this
      stretches into it; the targets below share what is left.
    */
    alignSelf: "stretch",
    /*
      A full pill, not a rounded rectangle. Measured off the reference, the
      bar's horizontal extent narrows symmetrically at both ends — 87.7→352pt
      at its top edge, widening to 52→387.7pt at its middle — which is a corner
      radius of half its height. `radii.pill` is that at any height;
      `radii.floating` (20) on a 66pt bar is a rectangle with the corners taken
      off, which is a different object.

      White fill and a soft shadow, and no border at all. The pale falloff at
      the reference's edges is the shadow, not a hairline.
    */
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  /**
   * One target, sharing the bar evenly.
   *
   * The bar's width is the screen's now — `layout.bottomBarInset` either side —
   * so the targets divide what is inside it rather than deciding it.
   * `flexBasis: bottomBarTarget` is what they each want: six of them plus the
   * bar's own padding is exactly the 336pt the reference measures on a 440pt
   * screen, so a full toolbar there lands on the reference. A route with one
   * action fewer spreads that same width between five rather than moving the
   * bar's edges, which is what a toolbar does — the pill is in the same place
   * on every screen and the icons stay evenly spaced inside it.
   *
   * `minWidth` is the floor and is why `flexShrink` is allowed at all: a narrow
   * phone with every action present would otherwise squeeze the targets below
   * what a thumb can hit, and this stops them at `MIN_TOUCH_TARGET` and lets
   * the row overflow visibly instead — an overflowing toolbar is a problem
   * somebody sees, and a row of 40pt targets is one nobody does.
   */
  target: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: layout.bottomBarTarget,
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
  },
  targetPressed: { backgroundColor: colors.chromePressed },

  /**
   * The rule between the note's verbs and the key that leaves the note.
   *
   * **It consumes width.** `flexShrink: 0` in the same flex row as the targets
   * means its `layout.bottomBarRule` point is subtracted from what the seven of
   * them divide, not painted over them: 317 ÷ 7 = 45.29 on a 390pt phone, not
   * 318 ÷ 7 = 45.4. This comment said 45.4 and was the one place that should
   * have caught the omission, since the width it was forgetting is the width it
   * is describing. `bottomBarGeometry` subtracts it explicitly for that reason.
   *
   * It stays a hairline and stays unshrinkable — a hairline that shrinks is a
   * hairline that disappears — and a *gap* instead of a rule is what there is
   * no room for; the targets are what absorb a narrow screen.
   *
   * Inset vertically rather than run edge to edge: a rule the full 66pt height
   * of a floating pill reads as a seam splitting the object in two, and what is
   * meant is a boundary *between two controls inside* one object.
   */
  separator: {
    flexGrow: 0,
    flexShrink: 0,
    width: layout.bottomBarRule,
    alignSelf: "center",
    height: 22,
    backgroundColor: colors.line,
  },
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
