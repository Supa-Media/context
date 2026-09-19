import { useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { atName } from "./format";
import { footPlan } from "./foot";
import { WorkspaceMark } from "./WorkspaceMark";
import { useWorkspaceIcons } from "./useWorkspaceIcons";
import type { ConsoleContext } from "./types";

/**
 * The workspaces, along the foot of the file tree.
 *
 * ```
 *  ┌──────────────────────────────┐
 *  │ 1-projects                   │
 *  │   october-group-airbnb-trip  │   the tree
 *  │ 2-areas                      │
 *  │ …                            │
 *  ├──────────────────────────────┤
 *  │ 384 of 512 notes             │   the counts foot
 *  ├──────────────────────────────┤
 *  │ ● @seyi        [S][P][C]  ⌄  │   this row
 *  └──────────────────────────────┘
 * ```
 *
 * Where you are, spelled out, and the three contexts you were in last beside
 * it. `foot.ts` holds every rule about what goes on it and in what shape, and
 * the header there argues all of them — why there are three, why the extra
 * width of a dragged-open panel buys names rather than a fourth mark, and why
 * nothing on this row ever gets an ellipsis.
 *
 * ## It is drawn here rather than anywhere else because the width was free
 *
 * The rail was folded away to give its 216 points to the note
 * (`docs/decisions/app-and-console.md`), and nothing about that decision has
 * weakened — which rules out every version of this that wants a column. What
 * this takes is about 40 points off the bottom of a panel that is already on
 * screen, in the one place on it that was not already spoken for.
 *
 * ## The current context is not pressable, and that is not an oversight
 *
 * On a phone the lit pill is the way up: `NavBand` puts it at the head of the
 * breadcrumb, where pressing it goes to the root of the context. Here the
 * breadcrumb is already on screen with its own head doing exactly that job, so
 * a second control for it would be two answers to one question — and the one
 * down here, at the far end of the panel from the path it acts on, is the worse
 * of the two. It is a label: it says where you are, and it is what tells you
 * the rest of the row is somewhere else.
 *
 * ## The chevron is `SwitcherMenu`, not a second menu
 *
 * Everything the row cannot hold — the workspaces past the third, Settings,
 * Leave, New workspace, "Claim your @name", Sign out — is behind the chevron,
 * and it is the *same component* the title bar's chip opens, mounted with
 * `trigger="chevron"`. A second list of the same rows is how one of them ends
 * up with a condition the other does not have, and `SwitcherMenu`'s own header
 * records what that cost the last time the rail was rearranged.
 */
export function ContextFootRow({
  contexts,
  currentSlug,
  recent,
  onOpen,
  menu,
}: {
  contexts: readonly ConsoleContext[];
  /** The context being browsed. `null` on the app-level panes. */
  currentSlug: string | null;
  /** The recency log from `lastPlace.ts`, most recently visited first. */
  recent: ReadonlyArray<{ slug: string }>;
  /**
   * Switch to a context.
   *
   * Resolved at press time by the caller, never at render: the log moves on
   * every navigation, so an href worked out when the row drew is the answer to
   * where somebody was two contexts ago. `ContextStrip` states the same rule
   * about the same log.
   */
  onOpen: (slug: string) => void;
  /** `SwitcherMenu` with `trigger="chevron"`. See the header. */
  menu?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    The row's own width, not the column's.

    `null` until the first layout, which `footPlan` reads as the resting column
    width rather than as zero — see its own note. Measuring here rather than
    taking `explorerWidth` as a prop keeps the arithmetic honest across a change
    to this component's padding, and it is the only thing that survives the
    panel being dragged: the drag writes `explorerWidth` on the frame, and what
    reaches this row is a new layout rather than a new prop.
  */
  const [width, setWidth] = useState<number | null>(null);
  /*
    `iconFor` answers `undefined` until a photo arrives, which is the letter —
    see the hook for why that beats a square that fills in late, and for why it
    only reads a cache that `useLiveConsoleData` fills.

    Above the `plan === null` return, because a hook after an early return is a
    hook that runs in some renders and not others.
  */
  const iconFor = useWorkspaceIcons();
  const plan = footPlan({ width, contexts, currentSlug, recent });
  if (plan === null) return null;

  /*
    The mark carries storage status, on the current context as much as on the
    others — `WorkspaceMark`'s own note: "a workspace whose storage is in trouble
    is still the thing your eye lands on first". An earlier draft drew this one
    `ok` unconditionally, which made the one workspace you could actually do
    something about the one the row would not warn you about.
  */
  const currentTone = contexts.find((c) => c.slug === currentSlug)?.status ?? "ok";
  const current = contexts.find((c) => c.slug === currentSlug);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    // Rounded and compared, because a resize emits a great many of these and a
    // sub-pixel difference is not a reason to re-plan the row.
    setWidth((current) => (current === next ? current : next));
  };

  return (
    <View style={styles.row} onLayout={onLayout} testID="context-foot-row">
      {currentSlug === null ? null : (
        <View
          style={styles.current}
          accessibilityLabel={`In ${atName(currentSlug)}`}
          testID="context-foot-current"
        >
          <WorkspaceMark
            label={atName(currentSlug)}
            tone={currentTone}
            icon={current === undefined ? undefined : iconFor(current)}
          />
          <Text variant="pill" numberOfLines={1} style={styles.currentLabel}>
            {atName(currentSlug)}
          </Text>
        </View>
      )}

      <View style={styles.spacer} />

      {plan.recent.map((context) => (
        <PressRow
          key={context.id}
          /*
            Spelled out rather than left to be concatenated from whatever the
            platform finds inside, which in the marks shape is a single letter.
            The rail's rule, quoted in `ContextStrip`: "a rail that becomes a row
            of unlabelled glyphs to a screen reader is not collapsed, it is
            broken".
          */
          accessibilityLabel={`Switch to ${atName(context.slug)}`}
          onPress={() => onOpen(context.slug)}
          radius={plan.named ? radii.pill : radii.sm}
          style={plan.named ? styles.pill : styles.mark}
          hoverStyle={styles.itemHover}
          testID={`context-foot-${context.slug}`}
        >
          <WorkspaceMark label={atName(context.slug)} tone={context.status} icon={iconFor(context)} />
          {plan.named ? (
            <Text variant="pill" numberOfLines={1} style={styles.pillLabel}>
              {atName(context.slug)}
            </Text>
          ) : null}
        </PressRow>
      ))}

      {menu}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /**
     * A hairline above, and the panel's own surface under it.
     *
     * No fill of its own: the counts foot immediately above this one has none
     * either, and two stacked strips each with a wash would read as a second
     * panel rather than as the bottom of this one.
     */
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: 10,
      paddingVertical: 9,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    /**
     * The current context, lit and not pressable. See the header.
     *
     * `flexShrink: 1` with `minWidth: 0` is the one place this row is allowed
     * to give: a name long enough to crowd the recents loses its own tail
     * rather than pushing them off the end. `footPlan` has already decided the
     * shape from the real widths, so this is the guard for the case the
     * estimate got wrong, not the mechanism.
     */
    current: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      flexShrink: 1,
      minWidth: 0,
      paddingLeft: 5,
      paddingRight: 9,
      paddingVertical: 4,
      borderRadius: radii.pill,
      backgroundColor: colors.accentDim,
    },
    currentLabel: { color: colors.accentText },

    /** Pushes the recents and the chevron to the trailing edge. */
    spacer: { flexGrow: 1, flexShrink: 0, minWidth: 0 },

    /** A recent, named: the mark and the name in a quiet pill. */
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      flexShrink: 0,
      paddingLeft: 5,
      paddingRight: 9,
      paddingVertical: 4,
      backgroundColor: colors.chipFill,
    },
    pillLabel: { color: colors.text2 },
    /** A recent, narrow: the mark alone, in a 24pt target. */
    mark: {
      width: 24,
      height: 24,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.chipFill,
    },
    itemHover: { backgroundColor: colors.surface3 },
  });
