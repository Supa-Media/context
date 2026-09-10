import { createContext, useContext, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { gradient } from "../design/css";
import { space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * A phone's navigation, in the scroller rather than over it.
 *
 * Two rows: the contexts you can switch **to**, and the path you are on with
 * the context you are **in** at the head of it.
 *
 *     ┌─────────────────────────────────────────────┐
 *     │ ● @public-worship   ● @supa   + New workspace│   row 1 — switch to
 *     │ ● @seyi / 1-projects / october-trip          │   row 2 — where you are
 *     └─────────────────────────────────────────────┘
 *
 * ## What this replaced, and why it is not styling
 *
 * The contexts were a row of pills in the floating top bar and the path was a
 * line of monospace inside the document. Both facts about that were reported
 * from a phone by the person using it:
 *
 * - **The bar floats, so the document ran behind the pills.** That is the
 *   frame's deliberate shape for chrome that acts on the note — the toolbar at
 *   the other edge earns it, because a verb you cannot reach is a verb you do
 *   not have. Navigation does not: a row of pills lying across the twentieth
 *   line of somebody's note is not reachability, it is an overlap with no
 *   scroll position that clears it.
 * - **`@seyi` was on the screen twice**, a pill above a breadcrumb naming the
 *   same context, on the surface with the least room to say anything once.
 *
 * ## The first answer to the duplication was wrong, and this is the second
 *
 * The first version deleted the context segment from the path and left the lit
 * pill on the strip. That removed the duplication and the **way up** with it:
 * a top-level folder has no ancestors, so the path row was empty and nothing on
 * the screen led back to the root of your own context. It shipped, and the
 * owner's report of it is the specification for what is here now:
 *
 * > when I'm on a workspace, the button for that workspace should essentially
 * > move to the breadcrumb… that workspace button removes from the workspace
 * > column, but is put in the breadcrumbs column. So I'm still able to get to
 * > the root.
 *
 * So the context you are in is **moved**, not deleted: `stripOrder` drops it
 * from row 1 and `CurrentContextPill` draws it at the head of row 2, where it
 * is the root of the path beside it and pressing it goes there. It is named
 * once, on the row where the name means a location rather than a destination.
 *
 * ## Row 2 is one scroller, and that is why the path is not its own
 *
 * The button and the segments scroll together: they are one line — *this
 * context, then this folder, then that one* — and two scrollers would let the
 * button sit still while the path it heads slid out from under it. So `NavBand`
 * owns the `ScrollView` and `Breadcrumb.pathOnly` returns bare segments into
 * it. Nothing truncates, on either row: a context or a folder ellipsised is two
 * of them that look identical, on the control whose whole job is telling them
 * apart.
 *
 * ## Why the nodes come through a context and not as props
 *
 * Both rows are built by `console/_layout` — they need the context list, the
 * recently-visited log and the router — and they have to be drawn inside a
 * scroller two levels below, which on Browse belongs to `BrowsePane` and on the
 * other panes to `EditorRegion`. Passing built nodes down is what keeps **one**
 * strip and **one** current-context button in the app: a second pair built at
 * the leaf is how one of them ends up with a handler the other does not have.
 */
interface NavBandNodes {
  /** The contexts you can switch to. `null` where there are none to offer. */
  contexts: ReactNode;
  /** The context you are in. `null` outside one — the app-level panes. */
  current: ReactNode;
}

const EMPTY: NavBandNodes = { contexts: null, current: null };

const NavBandContext = createContext<NavBandNodes>(EMPTY);

export function NavBandProvider({
  nodes,
  children,
}: {
  /** Both rows, built by the console layout. `EMPTY` off a phone. */
  nodes: NavBandNodes;
  children: ReactNode;
}) {
  return <NavBandContext.Provider value={nodes}>{children}</NavBandContext.Provider>;
}

/**
 * The two rows, or neither.
 *
 * Empty at every pointer density — the rail is the contexts there, and the full
 * breadcrumb is the path — and inside the landing page's picture of the
 * console, which has no layout above it. A caller renders `<NavBand>`
 * unconditionally and gets nothing where there is nothing.
 */
export function useNavBand(): NavBandNodes {
  return useContext(NavBandContext);
}

export function NavBand({
  gutter = 0,
  path,
  trailKey,
}: {
  gutter?: number;
  path?: ReactNode;
  /**
   * What "the same row" means, for the scroll position that survives a
   * re-render.
   *
   * The row is a plain scrollable `div` under the hood, so its scroll offset
   * is a property of *that DOM node*, not of the path it happens to be
   * showing — nothing about drawing a new, shorter path resets it, any more
   * than opening a new tab in a browser resets a sibling tab's scroll. Left
   * alone, a row scrolled right to read a deep leaf and then handed a shallow
   * one — a top-level note opened next — stays scrolled to a position the new,
   * shorter content may not even reach, which a browser clamps to its own new
   * end rather than to the start: the context pill and every ancestor scrolled
   * out of reach, for a path that never needed scrolling in the first place.
   *
   * Changing `key` is what a React row uses to say "this is not a scroll
   * position, this is a new row" — it throws the old DOM node away and mounts
   * a fresh one, whose scroll offset starts at zero the way a freshly opened
   * tab's does. `BrowsePane` passes the selected path (folder or note, joined
   * with the context id so a switch counts too) — cheap to compute, unique
   * enough for this, and it is the one fact that actually decides what "the
   * same position" means here.
   *
   * `undefined` — the default — asks for no remounting at all, which is right
   * for every other caller of this row: `EditorRegion`'s bare `<NavBand />`
   * passes no `path`, so there is nothing in the scroller whose position could
   * ever need resetting.
   */
  trailKey?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { contexts, current } = useNavBand();
  /*
    Nothing at all rather than an empty view with a gap in it. `current` is the
    load-bearing half of the test: a phone inside a context always has one, so
    this is really asking "is this a phone in a context", and the answer being
    `null` on Map, Connections and Settings without a context is why `contexts`
    alone would not do.
  */
  if (contexts == null && current == null && path == null) return null;
  return (
    <View style={[styles.band, gutter > 0 && { paddingHorizontal: gutter }]} testID="nav-band">
      {contexts}
      {current == null && path == null ? null : (
        <View style={styles.trailAnchor}>
          <ScrollView
            key={trailKey}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trail}
            /*
              The row is what scrolls; the band is as tall as the pill. Without
              this the ScrollView takes its height from the tallest thing in it
              and the row floats in a band of its own making — the same rule
              `ContextStrip` states about its own scroller.
            */
            style={styles.trailScroll}
            testID="nav-band-trail"
          >
            {current}
            {path}
          </ScrollView>
          {/*
            The falloff at the trailing edge, and it is `ContextStrip`'s rule
            rather than a second opinion: "a pill cut in half by a hard edge
            reads as a rendering bug, and the same pill under a falloff reads as
            a list". A deep path overflows this row far more often than the
            contexts overflow the one above — `1-projects/october-group-airbnb-trip`
            is already past a 390pt screen — so the row that needed it most was
            the one that shipped without it, which a screenshot caught and no
            test could.

            `pointerEvents="none"` because it lies over the last segment, and a
            gradient that ate a press would make the folder nearest the edge
            unpressable — the failure a decoration is allowed least of all.
          */}
          <View style={styles.fade} pointerEvents="none" aria-hidden testID="nav-band-fade" />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /**
   * No fill, no rule, and no vertical padding of its own.
   *
   * `Breadcrumb` argues the first two for the path line — on a phone there is
   * nothing above this but two floating buttons, so a filled bar here would be
   * a box drawn around a single line of type — and adding a second row does not
   * change the argument. The gap is the only thing separating the two rows, and
   * each row pays its own height.
   *
   * **The horizontal gutter is the caller's**, and both rows take it from here
   * rather than each carrying its own — which is the thing that was wrong the
   * first time this band was assembled. The strip used to be in the top bar and
   * took that bar's `space.x3`; dropped into a scroller with no padding of its
   * own it sat flush against the glass, a row of pills starting a quarter-inch
   * to the left of the note under it. Which number is right depends on what the
   * band is sitting above and only the caller knows: `layout.readingMargin`
   * over a document, nothing at all inside a pane whose own content container
   * already pays one.
   */
  band: { gap: space.x1 },
  /** Positioned, so the falloff can lie over the scroller rather than in it. */
  trailAnchor: { position: "relative" },
  trailScroll: { flexGrow: 0 },
  /**
   * The trailing falloff.
   *
   * To the editor's surface, because what is behind this row is the document.
   * 24pt is `ContextStrip`'s number for the same object at the same edge —
   * enough that a half-visible segment reads as continuing rather than as
   * clipped, and narrow enough not to dim a whole folder name.
   *
   * Native gets nothing from `gradient()` on some platforms and simply has no
   * fade; the row still scrolls, which is the part that matters.
   */
  fade: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 24,
    ...gradient(`linear-gradient(to right, ${colors.surfaceClear}, ${colors.surface})`),
  },
  /**
   * The context button and the path segments, on one line.
   *
   * `alignItems: "center"` because the two are different heights — a pill and a
   * line of monospace — and a baseline-aligned pill reads as having fallen off
   * the row.
   */
  trail: { flexDirection: "row", alignItems: "center", gap: 6 },
});
