import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ContextRowMenu } from "./ContextRowMenu";
import { Dot } from "../design/components/Dot";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { gradient } from "../design/css";
import { layout, radii, space } from "../design/tokens";
import { useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { offerOwnContext } from "../onboarding/route";
import { stripEntries, toneForKind } from "./strip";
import { atName } from "./format";
import type { ConsoleRoute } from "./nav";
import type { ConsoleContext } from "./types";

/**
 * The contexts, along the top of a phone.
 *
 * ## Why this exists at all
 *
 * A phone used to reach its other contexts through the rail, as a sheet the top
 * bar pulled in over the editor. That worked and cost more than it looked like:
 * every switch was a press to open a panel, a press to choose, and a scrim over
 * the note in between — and the panel was also the only route to the app's
 * other places, so one control carried two unrelated jobs and a person had to
 * know which. `features/app/frame.ts` has the whole argument and the invariant
 * it retired; the short version is that a phone now has **no left panel at
 * all**, and this row is half of what replaced it.
 *
 * The other half is the seventh key on the bottom row. Between them nothing
 * about navigating a phone is behind a control any more: the contexts are on
 * the glass, and so is the way to the app's other places.
 *
 * ## What is on it, and what is deliberately not
 *
 * Every context the viewer can reach, brains and workspaces undivided, ordered
 * by `strip.ts` — current first, then most recently visited. The kind is
 * the dot's colour rather than a heading, the strip carries no storage status,
 * and both of those are decisions with costs written down in that file.
 *
 * At the end sit the same two entries the rail keeps at the end of its groups,
 * under the same conditions and drawn the same way round: **"Claim your @name"
 * accented**, because the person it is for arrived through somebody else's
 * invitation and has no reason to suspect the product does anything else, and
 * it stops existing the moment it is used; **"New workspace" quiet**, because
 * it is a permanent verb and an accent on it would be an advertisement on every
 * screen of every session. `rail.ts` and `app-and-console.md` argue both; this
 * is the same decision on a second surface, not a new one.
 *
 * ## Three things about the drawing that are rules rather than styling
 *
 * **It scrolls and never wraps.** A second row of pills is a second band of
 * chrome, on the surface with the least room for one, appearing and
 * disappearing as somebody joins a workspace. `ScrollView horizontal` with
 * `flexShrink: 0` pills is the whole of it, and the fade at the trailing edge
 * is what says there is more — a pill cut in half by a hard edge reads as a
 * rendering bug, and the same pill under a falloff reads as a list.
 *
 * **Nothing truncates.** A pill is as wide as its name. `@acme-engineering`
 * ellipsised to `@acme-eng…` is two contexts that look identical, on the one
 * control whose entire job is telling them apart — so the row gets longer and
 * the scroll absorbs it. This is why there is no `numberOfLines` anywhere in
 * this file, and why adding one is a bug rather than a tidy-up.
 *
 * **Every pill has a real accessibility label.** The rail's own comment records
 * what this rule is for: "a rail that becomes a row of unlabelled glyphs to a
 * screen reader is not collapsed, it is broken", which is what killed an
 * earlier icon-only collapse. A pill here has visible text, but the dot beside
 * it does not and the current pill's state is a colour — so the name is spelled
 * out rather than left to be concatenated from whatever the platform finds
 * inside.
 *
 * ## The menu is outside the scroller, and that is not a detail
 *
 * A long press opens `ContextRowMenu` — the same menu the rail opens on a
 * right-click, reused rather than reimplemented, so Open / Settings… / Manage
 * sharing… / Leave are one list with one set of rules about when Leave is
 * offered. It is rendered as a child of the strip's root rather than of the
 * pill, because the pills live in a horizontally scrolling view: a dropdown
 * inside that view is clipped by it, which on the web is a menu that simply
 * does not appear. Anchored to the strip it drops below the whole row, which is
 * also where a thumb already is.
 */
export function ContextStrip({
  contexts,
  currentSlug,
  recent,
  loading,
  onOpen,
  onSelect,
  onLeaveContext,
  onClaimContext,
  onCreateWorkspace,
}: {
  contexts: readonly ConsoleContext[];
  /** The context being read right now. Pinned first, and lit. */
  currentSlug: string | null;
  /**
   * Most recently visited first — `useContextPlaces()`.
   *
   * Bare slugs by type, so this component imports no store. Empty until the
   * device answers, which orders the strip by the control plane's list for a
   * tick rather than drawing nothing.
   */
  recent: ReadonlyArray<{ slug: string }>;
  /** True while the context list's first round trip is outstanding. */
  loading: boolean;
  /**
   * Open a context.
   *
   * A slug rather than a route, because **where a context opens is not this
   * component's decision**: it is the path this device last had open there
   * (`contextHrefFor`), resolved by the layout at press time. A route worked
   * out when the strip rendered is the answer to where somebody was two
   * contexts ago.
   */
  onOpen: (slug: string) => void;
  /** A destination chosen from the long-press menu. */
  onSelect: (route: ConsoleRoute) => void;
  /** Leave a context. Receives the workspace id, like the rail's. */
  onLeaveContext?: (contextId: string) => void;
  /**
   * Claim a name, and make a workspace. Absent where there is nowhere to send
   * anybody — the landing page's picture of the console, the read-only demo —
   * which is also what makes a one-context strip disappear there. See
   * `stripEntries`.
   */
  onClaimContext?: () => void;
  onCreateWorkspace?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  // One menu at a time: opening a second closes the first, which is what every
  // menu bar does. The rail holds the same one answer for the same reason.
  const [menuSlug, setMenuSlug] = useState<string | null>(null);

  const claim =
    onClaimContext !== undefined && offerOwnContext({ contexts, loading });
  const create = onCreateWorkspace !== undefined;
  const ordered = stripEntries(contexts, currentSlug, recent, { claim, create });
  if (ordered === null) return null;

  const menuContext = contexts.find((context) => context.slug === menuSlug) ?? null;

  /*
    A landmark, because on a phone this is *the* navigation and nothing else is.

    `AppFrame` declares `role="navigation"` on the rail column and on the rail
    sheet. Neither is rendered at compact — a phone has no rail
    (`features/app/frame.ts`) — and neither this strip nor `BottomBar` declared
    one, so a phone-width browser window had **zero** navigation landmarks: a
    screen-reader user rotoring by landmark, or a browser extension jumping to
    `<nav>`, found the whole of this console's navigation unreachable that way.
    Every pill has a real `aria-label`, which is what makes each *control*
    usable and is not the same capability as being able to find the group.

    `Contexts` rather than the rail's `Console`, because that is what this list
    is, and because the two are never on screen together — the rail is hidden at
    compact and this slot is only rendered there — so the names do not have to
    disambiguate anything, only describe.

    The bottom row keeps `role="toolbar"` and is deliberately not a second
    landmark: six of its seven keys are verbs about the open note, and calling a
    row of verbs "navigation" because one destination sits at the end of it
    behind a separator would make the landmark mean less, not more.
  */
  return (
    <View
      style={styles.strip}
      role="navigation"
      aria-label="Contexts"
      testID="context-strip"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        /*
          The row is what scrolls; the strip is what is 34pt tall. Without this
          the ScrollView takes its own height from the tallest thing in it and
          the pills float in a band of their own making.
        */
        style={styles.scroll}
        testID="context-strip-scroll"
      >
        {ordered.map((context) => (
          <Pill
            key={context.id}
            label={atName(context.slug)}
            accessibilityLabel={
              context.slug === currentSlug
                ? `${atName(context.slug)}, the context you are in`
                : `Open ${atName(context.slug)}`
            }
            current={context.slug === currentSlug}
            leading={<Dot tone={toneForKind(context)} />}
            onPress={() => onOpen(context.slug)}
            onLongPress={() => setMenuSlug(context.slug)}
            testID={`context-strip-${context.slug}`}
          />
        ))}

        {/*
          The claim entry, accented, at the end — the rail's rule and the rail's
          reason. It is a gap in the list rather than a verb about the
          application, so it sits after the contexts it is a gap among.
        */}
        {claim ? (
          <Pill
            label="Claim your @name"
            accessibilityLabel="Claim your name and create your own brain"
            accented
            leading={<Icon name="plus" size={13} />}
            onPress={onClaimContext!}
            testID="context-strip-claim"
          />
        ) : null}

        {create ? (
          <Pill
            label="New workspace"
            accessibilityLabel="Create a new shared workspace"
            leading={<Icon name="plus" size={13} />}
            onPress={onCreateWorkspace!}
            testID="context-strip-create"
          />
        ) : null}
      </ScrollView>

      {/*
        The falloff at the trailing edge, over the scroller rather than in it.

        `pointerEvents="none"` because it lies across the pills at that end and
        a gradient that ate a press would make the last reachable context
        unpressable — which is the failure a decoration is allowed least of all.
        Native gets nothing from `gradient()` on some platforms and simply has
        no fade; the row still scrolls, which is the part that matters.
      */}
      <View style={styles.fade} pointerEvents="none" aria-hidden testID="context-strip-fade" />

      {/*
        Anchored to the strip, not to the pill — a dropdown inside the
        horizontal scroller is clipped by it. See the file comment.
      */}
      {menuContext === null ? null : (
        <ContextRowMenu
          slug={menuContext.slug}
          // The role, not the row's position: every workspace is "shared" under
          // this arrangement and some of them are yours, so a section-derived
          // answer offers Leave on a workspace you own and the press comes back
          // `OWNER_CANNOT_LEAVE`. Same rule as the rail's.
          canLeave={menuContext.role !== "owner"}
          onSelect={(target) => {
            setMenuSlug(null);
            onSelect(target);
          }}
          onLeave={
            onLeaveContext
              ? () => {
                  setMenuSlug(null);
                  onLeaveContext(menuContext.id);
                }
              : undefined
          }
          onDismiss={() => setMenuSlug(null)}
        />
      )}
    </View>
  );
}

/**
 * One pill.
 *
 * `flexShrink: 0` is the rule rather than the styling: a flex child in a row
 * shrinks by default, so without it the pills would compress to fit the strip's
 * width instead of overflowing it — every name ellipsised, nothing scrolling,
 * and the more contexts somebody has the less legible all of them get. The
 * scroller is what absorbs the width.
 */
function Pill({
  label,
  accessibilityLabel,
  current = false,
  accented = false,
  leading,
  onPress,
  onLongPress,
  testID,
}: {
  label: string;
  accessibilityLabel: string;
  /** The context being read. Lit, and always first. */
  current?: boolean;
  /** The claim entry, and only that one. See the file comment. */
  accented?: boolean;
  leading?: React.ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="button"
      accessibilityLabel={accessibilityLabel}
      // The lit pill is a *selected* control rather than a differently coloured
      // one, so a screen reader is told the same thing the colour says.
      aria-selected={current || undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      /*
        The **target**, which draws nothing. `accountAvatar`'s rule — "what a
        thumb hits is the pressable around it, and the caller pads to the floor"
        — finally applied here: the mark inside is what somebody sees, and this
        is what they hit. Collapsing the two is how "make the pills smaller"
        becomes navigation a phone misses.
      */
      style={styles.target}
    >
      {({ pressed }) => (
      <View
        style={[
          styles.pill,
          current && styles.pillCurrent,
          accented && styles.pillAccent,
          pressed && styles.pillPressed,
        ]}
        testID={testID === undefined ? undefined : `mark-${testID}`}
      >
      {leading}
      {/*
        No `numberOfLines`. A truncated context name is two contexts that look
        the same on the control whose job is telling them apart — see the file
        comment.
      */}
      <Text
        variant="wsSwitch"
        style={[
          current && styles.pillCurrentLabel,
          accented && styles.pillAccentLabel,
        ]}
      >
        {label}
      </Text>
      </View>
      )}
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  /**
   * The band, which is the flexible middle of the phone's top row.
   *
   * **`flex: 1` is the whole of it, and that is worth saying because the obvious
   * second half is a no-op here.** In CSS a flex child's automatic minimum size
   * is its content, so the reflex is `minWidth: 0` to stop a strip holding six
   * long names from pushing the trailing capsule off the glass. That line was
   * written, and sabotaging it changed nothing: react-native-web puts
   * `min-width: 0` (and `min-height: 0`) in the **base style of every `View`**,
   * and Yoga has no `min-width: auto` to begin with, so there is nothing on
   * either platform for it to override. It is gone, along with the assertion
   * that was passing over its absence.
   *
   * What actually keeps the capsule safe is this `flex: 1` — the strip takes
   * what the pinned account mark and the capsule leave, and no more — and the
   * scroller inside it, which does not size to its content.
   */
  strip: {
    flex: 1,
    alignSelf: "stretch",
    justifyContent: "center",
    position: "relative",
  },
  scroll: { flexGrow: 0 },
  /** Tighter than `space.x2`: the gap is the other half of "more of them fit". */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  /**
   * A pill lying on the note, the same object the toggle and the capsule beside
   * it are: `chrome` fill, a floating shadow, a full radius. The top row has no
   * surface of its own — see `AppFrame`'s `topBarCompact` — so anything on it
   * that is not drawn as an object has nothing behind it.
   *
   * `chromeButton` is the height so the row reads as one line of chrome rather
   * than three heights, and it is `minTouchTarget`, so a pill clears the floor
   * without needing a number of its own.
   */
  /**
   * What a thumb hits. It draws nothing.
   *
   * `minTouchTarget` on both axes with the mark centred inside it, so the pill
   * can be as small as the design wants without the target following it down.
   * `contextStrip.test.ts` holds both halves and they fail separately.
   */
  target: {
    flexShrink: 0,
    height: layout.minTouchTarget,
    justifyContent: "center",
  },
  /**
   * What somebody sees: smaller than the target and squarer than a stadium.
   *
   * The owner asked for both, off a real recording — "smaller and squarer" so
   * more workspaces are on screen at once — and the horizontal saving is where
   * that is actually paid: `space.x2` of padding instead of `space.x3`, and a
   * tighter gap on the row, which is what puts another context on the glass at
   * 390pt rather than the two points of height.
   *
   * `radii.md` rather than `radii.pill` is the "squarer" half. A stadium reads
   * as a *button*; a rounded rectangle reads as a tab, which is what this is.
   */
  pill: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: layout.stripPill,
    paddingHorizontal: space.x2,
    borderRadius: radii.md,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },
  pillPressed: { backgroundColor: colors.chromePressed },
  /**
   * Where you are.
   *
   * Filled rather than outlined, because the strip is read at a glance while
   * scrolling and a border is the first thing that stops being visible at that
   * speed. It is also always the first pill (`stripOrder`), so the two signals
   * agree and neither has to carry it alone.
   */
  pillCurrent: { backgroundColor: colors.accentDim },
  pillCurrentLabel: { color: colors.accentText },
  /** The claim entry only. See the file comment for why not "New workspace". */
  pillAccent: { backgroundColor: colors.accentDim },
  pillAccentLabel: { color: colors.accentText },

  /**
   * The trailing falloff.
   *
   * To the editor's surface rather than to the chrome, because the compact top
   * row draws no surface of its own and what is behind the strip at that edge
   * is the document. 24pt is about a pill's leading padding plus its dot —
   * enough that a half-visible pill reads as continuing rather than as clipped,
   * and narrow enough not to dim a whole name.
   */
  fade: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 24,
    ...gradient(`linear-gradient(to right, ${colors.surfaceClear}, ${colors.surface})`),
  },
});
