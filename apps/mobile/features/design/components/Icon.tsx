import { StyleSheet, View, type ViewStyle } from "react-native";
import { useColors } from "../theme";
import { drawIcon } from "./icons";
import { ICON_NAMES, type IconName } from "./icons/names";

/**
 * The icon set, drawn from `View`s.
 *
 * ## Why this exists
 *
 * Every control in this app used to carry a Unicode character — `☰` for the
 * file tree, `⌕` for search, `＋` for new, `✓` for save. `BottomBar` measured
 * them in Chromium at 19px and found `☰` 17px wide, `＋` 19 and `⌕` **10.6**,
 * and drew the correct conclusion for a toolbar of four of them: a bare-glyph
 * row "reads as three buttons and a smudge". Its answer was a caption under
 * every one, which normalises the row and is also how a phone toolbar ends up
 * looking like a 2011 tab bar rather than like Obsidian's.
 *
 * These are the same size as each other because they are drawn in the same box
 * at the same stroke width, which is what an icon set *is*. The captions are
 * no longer load-bearing, and `BottomBar` says so where it used to argue for
 * them.
 *
 * ## Why not an icon font or an SVG library
 *
 * `react-native-svg` was refused here on two grounds, and **both have now
 * expired** — so two drawings in this file are paths. See "The escape hatch"
 * below for which, and for the rule that keeps it at two.
 *
 * The first reason went a while ago. It said the dependency was native, so it
 * would land in `native-deps.json` and need a new development build on both
 * platforms before anybody could see a single icon. It is in `package.json` at
 * 15.12.1 and in `native-deps.json` `core` — every build already carries it,
 * because the baseline was deliberately over-provisioned before the first
 * binary — so that cost is paid and there is no build to wait for.
 *
 * The second was the load-bearing one: it buys nothing this app needs, because
 * *"there is no icon here with a curve a rectangle cannot fake"*. The eye is
 * that curve, and it took two failed attempts to establish it. A rectangle can
 * fake a curve; what it cannot fake is **a curve at constant stroke weight**.
 * A rounded border tapers to nothing where two borders of different widths
 * meet — which is an eyelid's canthus and is also why the eye read first as a
 * toggle switch and then as a pair of brush strokes. Walking the same arc as
 * round-capped `bar`s holds the weight and beads at every joint instead. The
 * owner's reference — one weight the whole way round, meeting in points — is
 * not reachable from `borderRadius`, and the third attempt was a `<Path>`.
 *
 * An icon font is still worse than either: a binary in the repo, a load that
 * can fail, and a glyph box we would be back to fighting.
 *
 * A `View` with a background colour is a `<div>` on web and a layer on native.
 * Rotation is `transform`, which both platforms have. That is still the whole
 * toolkit for forty-odd of these, and it costs nothing to reach for.
 *
 * ## The escape hatch
 *
 * **Reach for a path only when the drawing needs a curve at constant weight.
 * Everything a rectangle can fake stays a rectangle.** Two icons qualify —
 * `eye` and `pencil` — and they are drawn by `glyph` (in
 * `icons/primitives.tsx`), in the same unit space as everything else. That is
 * a stated trigger rather than an open door: without it this file becomes a
 * slow, unargued rewrite in which the forty working drawings are churned one
 * at a time for no gain.
 *
 * ## The rules
 *
 * - **One box.** Every icon occupies exactly `size × size`, so a row of them
 *   aligns without per-icon nudging. Nothing draws outside it.
 * - **One stroke.** `strokeFor` derives the weight from the size, so a 16pt
 *   icon and a 24pt icon look like the same family rather than like two.
 *   Callers may override it; almost none should.
 * - **Geometry is fractions of the box**, never points. An icon asked for at
 *   28 is the same drawing as one asked for at 16, and adding a point of size
 *   cannot silently move a stroke off centre.
 * - **Decorative, always.** An icon is `aria-hidden` and has no accessible
 *   name of its own — the control around it carries one. There is no `label`
 *   prop, because a prop that is usually omitted is how a screen reader ends
 *   up announcing "button".
 * - **It says which icon it is, in the DOM.** `data-icon="chevronDown"`, via
 *   `dataSet` — which react-native-web renders as a data attribute and native
 *   ignores. A glyph could be asserted by reading the text content of the
 *   control; an icon drawn from `View`s has no text at all, so without this a
 *   test can only check that *something* decorative is present, and "the
 *   chevron turns over when the sheet opens" becomes unassertable. That is
 *   exactly the shape of guard this repo keeps finding was never checked.
 *
 * ## Where the drawings live
 *
 * `ICON_NAMES` and the `IconName` union are declared in `icons/names.ts`. Each
 * icon's actual drawing lives in one of the semantic families under
 * `icons/` — `navigation`, `files`, `editor`, `status`, `brand` — composed
 * back into one `drawIcon` map by `icons/index.ts`. The shared drawing
 * primitives (`bar`, `ring`, `dot`, `rect`, `chevron`, `shackle`, `cradle`,
 * `glyph`) live in `icons/primitives.tsx`.
 */

export { ICON_NAMES, type IconName };

/**
 * The stroke weight for a box of this size.
 *
 * Rounded to a half point rather than to a whole one: on a 2x or 3x screen a
 * half point is a whole pixel, and clamping to integers makes a 16pt icon
 * either 25% heavier or 25% lighter than a 20pt one from the same set.
 */
export function strokeFor(size: number): number {
  return Math.max(1, Math.round(size * 0.09 * 2) / 2);
}

/**
 * `dataSet`, spread rather than written as a prop.
 *
 * react-native-web turns `dataSet={{ icon: "search" }}` into
 * `data-icon="search"` and React Native drops it as an unknown prop, which is
 * the behaviour wanted on both — but it is not in React Native's `ViewProps`,
 * so the type has to be widened somewhere. Widened here, in one named place,
 * the way `AppFrame` handles `inert` and `css.ts` handles gradients, rather
 * than with an `as any` at the call site.
 */
function iconData(name: IconName): Record<string, unknown> {
  return { dataSet: { icon: name } };
}

export function Icon({
  name,
  size = 20,
  color,
  strokeWidth,
  style,
}: {
  name: IconName;
  size?: number;
  /** Defaults to `text2` in the palette in force. */
  color?: string;
  /** Override the derived weight. Almost nothing should. */
  strokeWidth?: number;
  style?: ViewStyle;
}) {
  const colors = useColors();
  // Resolved here rather than as a default parameter value: those are
  // evaluated in the parameter list, before any hook has run, so an icon
  // defaulted there would be drawn in whichever palette the module happened to
  // import instead of the one this subtree is in.
  const stroke = color ?? colors.text2;
  const w = strokeWidth ?? strokeFor(size);
  return (
    <View
      style={[styles.box, { width: size, height: size }, style]}
      {...iconData(name)}
      aria-hidden
      // Native's half of the same claim: `aria-hidden` is a web attribute and
      // is dropped on iOS and Android, where an unlabelled `View` inside a
      // labelled control is still walked by VoiceOver unless it is told not
      // to be.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {drawIcon[name](size, w, stroke)}
    </View>
  );
}

/**
 * The keys of one icon's strokes, for the test that they are distinct.
 *
 * Exported for the same reason `ICON_NAMES` is a value: the thing that goes
 * wrong here is invisible from outside. `chevron` hardcoded `key="chevron"`
 * while every other primitive took one, so `exchange` — two bars and two
 * chevrons — drew two children under one key and React complained over the
 * rail on a phone. Nothing was missing from the screen; the only symptom was a
 * red toast in a development build, which is why it survived.
 *
 * A key never reaches the DOM, and React 19 does not warn for this shape on a
 * first mount, so there is nothing to inspect after rendering and nothing to
 * catch by listening. The keys have to be read from the drawing itself.
 */
export function strokeKeys(name: IconName): (string | null)[] {
  const drawn = drawIcon[name](24, 2, "rgb(1, 2, 3)");
  return (Array.isArray(drawn) ? drawn : [drawn]).map((stroke) => stroke.key);
}

const styles = StyleSheet.create({
  box: { position: "relative" },
});
