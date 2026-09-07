import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../design/tokens";

/**
 * A phone's navigation, in the scroller rather than over it.
 *
 * ## What this replaced, and why it is not styling
 *
 * The contexts were a row of pills in the floating top bar and the path was a
 * line of monospace inside the document, one under the other. Both facts about
 * that arrangement were reported from a phone by the person using it:
 *
 * - **The bar floats, so the document ran behind the pills.** That is the
 *   frame's deliberate shape for chrome that acts on the note — the toolbar at
 *   the other edge earns it, because a verb you cannot reach is a verb you do
 *   not have. Navigation does not: a row of pills lying across the twentieth
 *   line of somebody's note is not reachability, it is an overlap with no
 *   scroll position that clears it. "The top workspaces should scroll with the
 *   note; to change workspace I should have to scroll up."
 * - **`@seyi` was on the screen twice**, a pill above a breadcrumb, on the
 *   surface with the least room to say anything once.
 *
 * So the contexts moved to where the path already was, and the two became one
 * band: the contexts on top, the path under them, both inside whatever scroller
 * the surface owns. It scrolls away with the document and comes back by
 * scrolling up. The duplication is gone because the band names the context in
 * exactly one place — the lit pill — and the path below it starts at the first
 * folder.
 *
 * ## The way up is the lit pill
 *
 * Dropping the context segment from the path took the way *up* from a top-level
 * folder with it, which is the reason `Breadcrumb.pathOnly` had put it back
 * there in the first place. Pressing the current context's pill is what carries
 * that now: it opens the context at its root rather than at the place this
 * device last had open there (`console/_layout`), which is the one press in the
 * strip that used to do nothing you could see.
 *
 * ## Why it is a context and not a prop
 *
 * The strip is built by `console/_layout` — it needs the context list, the
 * recently-visited log and the router — and it has to be drawn inside a
 * scroller two levels below, which on Browse belongs to `BrowsePane` and on the
 * other panes to `EditorRegion`. Passing the built node down is what keeps
 * **one** strip in the app: a second one constructed at the leaf would be two
 * copies of a control, which is how one of them ends up with a handler the
 * other does not have.
 */
const NavBandContext = createContext<ReactNode>(null);

export function NavBandProvider({
  node,
  children,
}: {
  /** The context strip, built by the console layout. `null` off a phone. */
  node: ReactNode;
  children: ReactNode;
}) {
  return <NavBandContext.Provider value={node}>{children}</NavBandContext.Provider>;
}

/**
 * The contexts row, or `null` where there is not one.
 *
 * `null` at every pointer density — the rail is the contexts there — and inside
 * the landing page's picture of the console, which has no layout above it.
 * A caller renders `<NavBand>` unconditionally and gets nothing when both rows
 * are absent.
 */
export function useNavBand(): ReactNode {
  return useContext(NavBandContext);
}

/**
 * The band itself: the contexts, then the path.
 *
 * Renders nothing at all when it has neither, rather than an empty view with a
 * gap in it — a band of chrome that appears on a screen with nothing in it is
 * the second row of pills `ContextStrip` refuses to grow.
 */
export function NavBand({ path }: { path?: ReactNode }) {
  const contexts = useNavBand();
  if (contexts == null && path == null) return null;
  return (
    <View style={styles.band} testID="nav-band">
      {contexts}
      {path}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * No fill, no rule, and no vertical padding of its own.
   *
   * `Breadcrumb` argues the first two for the path line — on a phone there is
   * nothing above this but two floating buttons, so a filled bar here would be
   * a box drawn around a single line of type — and adding a second row does not
   * change the argument. The gap is the only thing separating the two rows, and
   * each row pays its own height.
   */
  band: { gap: space.x1 },
});
