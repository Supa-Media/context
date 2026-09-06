import type { ReactElement } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useColors } from "../theme";

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
 * `react-native-svg` is the obvious answer, and one of the two reasons given
 * here for not taking it has expired. It said the dependency was native, so it
 * would land in `native-deps.json` and need a new development build on both
 * platforms before anybody could see a single icon. It is in `package.json` at
 * 15.12.1 and in `native-deps.json` `core` — every build already carries it,
 * because the baseline was deliberately over-provisioned before the first
 * binary — so that cost is paid and there is no build to wait for.
 *
 * The reason that survives is the one that was doing the work anyway: it buys
 * nothing this app needs. There is no icon here with a curve a rectangle
 * cannot fake, and the two that have one (the search lens, a dot) are circles,
 * which `borderRadius` draws exactly. An icon font is worse again: a binary in
 * the repo, a load that can fail, and a glyph box we would be back to
 * fighting.
 *
 * A `View` with a background colour is a `<div>` on web and a layer on native.
 * Rotation is `transform`, which both platforms have. That is the whole
 * toolkit, and it costs nothing to reach for.
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
 */

/**
 * Every icon in the set, as a value.
 *
 * An array with the type derived from it, rather than a union with the names
 * typed again in a test. `draw` below is a `switch` with no `default`, so a
 * name added to the union and not to the `switch` returns `undefined` — an
 * icon that renders an empty box of the right size, in a control that still
 * has its accessible name, on a surface with no hover to reveal what it was
 * meant to be. Nothing about that is loud.
 *
 * With the names as a value, `icons.test.ts` walks the whole set and asserts
 * each one draws something. The list is the guard; the union follows it.
 *
 * **It holds what is drawn today and nothing else.** A first pass also carried
 * a hamburger, a sliders mark, a book, a share arrow and a wastebasket, none of
 * which had a caller — a set of speculative marks is a set nobody checks, and
 * the one that eventually gets used is the one drawn against no real control.
 * Add an icon when a control needs it, in the same change as the control.
 */
export const ICON_NAMES = [
  /** The sidebar toggle, as Obsidian draws it: a pane with its leading column filled. */
  "panelLeft",
  "search",
  "plus",
  "check",
  "close",
  "chevronLeft",
  "chevronRight",
  "chevronUp",
  "chevronDown",
  "arrowLeft",
  "arrowRight",
  "more",
  "folder",
  "file",
  /** The Map pane: nodes with edges between them. */
  "constellation",
  /** The Connections pane: a two-way exchange, which is what a grant is. */
  "exchange",

  /*
    From here down: the Obsidian-parity editing surface. The keyboard accessory
    bar that rides above the keyboard while a note is open, and the toolbar
    across the top of the note. Both are dense rows of unlabelled 20pt targets
    with no room for a caption under any of them, which is the case the header
    at the top of this file argues these drawings exist for at all. Each is
    added here in the same change as the control that reaches for it; for the
    bar's keys, see `console/files/NoteAccessory.tsx`.
  */

  /**
   * The accessory bar's undo. Its mirror `redo` follows it, and the two are
   * told apart by the arrowhead alone — the arc between them is symmetric.
   */
  "undo",
  "redo",
  /** The accessory bar's task-checkbox key, drawn as the `[ ]` it inserts. */
  "brackets",
  /**
   * A tag, which would insert a `#`, and a paperclip, for embedding a file.
   *
   * **Neither has a caller**, which is the one exception to the rule stated at
   * the top of this list, and it is recorded rather than quietly kept: they
   * were drawn for a first accessory bar that mirrored Obsidian's row key for
   * key. `NoteAccessory` drops both on purpose — Context has no tag model and
   * no attachment upload from the console — and says so at length. Delete them
   * with the next person who reads this if neither feature has arrived.
   */
  "tag",
  "attach",
  /** The accessory bar's heading key, drawn as the letter it inserts. */
  "heading",
  "bold",
  "italic",
  /**
   * The accessory bar's rightmost key, which dismisses the keyboard — the one
   * the whole bar exists for.
   */
  "keyboardHide",
  /** The toolbar's reading-view toggle, as Obsidian draws it: an open book. */
  "book",
  /** The toolbar's settings. */
  "gear",
  /** The toolbar's filter, over the note list. */
  "filter",
  /**
   * The note toolbar's Share, in the group at the top-right of a phone.
   *
   * The share *graph* — three nodes and the two edges between them — rather
   * than iOS's arrow out of a tray. That mark means "send this somewhere
   * else"; a share here grants somebody a way in to a note that stays exactly
   * where it is, which is a relationship rather than a departure.
   */
  "share",
  /**
   * The file tree's sort order, as Obsidian draws it: an up arrow beside three
   * rules of decreasing length.
   *
   * The arrow is what makes it a *sort* rather than a filter — `filter` above
   * is the same stack of rules with no arrow, and the two would be one mark
   * without it.
   */
  "sort",
  /** The file tree's collapse-all: a pane with only its top band left open. */
  "collapse",
  /**
   * Visibility, in the group beside Share — the same control on a note and on a
   * folder, and it draws the state a thing **is in** rather than the state it
   * would move to.
   *
   * A padlock reads as *private* everywhere, so the shut one is `private` and
   * the open one is `team`. That is the opposite of the label it replaces
   * ("Make this folder private", which named the destination), and it is the
   * right way round for an unlabelled 20pt target: an icon says what is true, a
   * verb says what will happen, and only one of those can sit beside a share
   * button that also says what is true.
   */
  "lock",
  "lockOpen",
  /**
   * The third position of that same control: a link anybody who has it can
   * open, with no sign-in.
   *
   * A globe rather than a wider-open padlock, because the axis changes at that
   * step and the mark should change with it. Shut and open are two states of
   * one object and read as *degrees* of the same thing — which is right for
   * "me" versus "my team", and wrong for "and now people I have never met".
   * A padlock at its third setting is the picture of a lock that is merely
   * looser; the world is the picture of who is on the other side.
   */
  "globe",
  /**
   * Meeting capture, in the rail.
   *
   * A microphone on its cradle rather than a waveform or a red disc, and both
   * of those were considered. A waveform is what the *recording bar* already
   * draws while something is running, and reusing it for a destination would
   * make the mark that means "a meeting is being recorded right now" also mean
   * "meetings live here". A red disc is the record button on `/meetings`, which
   * is a verb — this row navigates and starts nothing, and a mark promising
   * otherwise is the consent problem `docs/decisions/meetings.md` spends a
   * section on.
   */
  "mic",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

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
      {draw(name, size, stroke, w)}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  drawing                                   */
/* -------------------------------------------------------------------------- */

/**
 * One stroke, positioned by its **centre** in unit coordinates.
 *
 * Centres rather than corners because every measurement that matters here is a
 * centre — a bar sits on a line, a rotation happens about a midpoint — and
 * converting to a top-left at each call site is where the off-by-half-a-stroke
 * errors live.
 */
function bar(
  key: string,
  u: number,
  w: number,
  color: string,
  { cx, cy, length, angle = 0 }: { cx: number; cy: number; length: number; angle?: number },
) {
  const px = length * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - px / 2,
        top: cy * u - w / 2,
        width: px,
        height: w,
        borderRadius: w / 2,
        backgroundColor: color,
        ...(angle === 0 ? null : { transform: [{ rotate: `${angle}deg` }] }),
      }}
    />
  );
}

/** A circle outline, centred in unit coordinates. */
function ring(
  key: string,
  u: number,
  w: number,
  color: string,
  { cx, cy, r }: { cx: number; cy: number; r: number },
) {
  const d = r * 2 * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - d / 2,
        top: cy * u - d / 2,
        width: d,
        height: d,
        borderRadius: d / 2,
        borderWidth: w,
        borderColor: color,
      }}
    />
  );
}

/** A filled dot, centred in unit coordinates. */
function dot(key: string, u: number, color: string, { cx, cy, r }: { cx: number; cy: number; r: number }) {
  const d = r * 2 * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - d / 2,
        top: cy * u - d / 2,
        width: d,
        height: d,
        borderRadius: d / 2,
        backgroundColor: color,
      }}
    />
  );
}

/** A rectangle outline, positioned by its edges in unit coordinates. */
function rect(
  key: string,
  u: number,
  w: number,
  color: string,
  {
    x0,
    y0,
    x1,
    y1,
    radius = 0.14,
    fill,
  }: { x0: number; y0: number; x1: number; y1: number; radius?: number; fill?: string },
) {
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: x0 * u,
        top: y0 * u,
        width: (x1 - x0) * u,
        height: (y1 - y0) * u,
        borderRadius: radius * u,
        ...(fill === undefined ? { borderWidth: w, borderColor: color } : { backgroundColor: fill }),
      }}
    />
  );
}

/**
 * A chevron: a square carrying two adjacent borders, turned to point.
 *
 * Two borders rather than two rotated bars, because a corner joined by the
 * layout engine is a clean mitre at every size and two bars meeting at a point
 * are two bars with a notch between them at exactly the sizes a phone uses.
 *
 * It takes a `key` like every other primitive here, and that is a fix rather
 * than symmetry: the key used to be the constant `"chevron"`, so `exchange` —
 * the one drawing with two of them — handed React two children with the same
 * key. `keyboardHide` below is the second such drawing, which is what made the
 * constant worth noticing.
 */
function chevron(
  key: string,
  u: number,
  w: number,
  color: string,
  { cx, cy, side, angle }: { cx: number; cy: number; side: number; angle: number },
) {
  const d = side * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - d / 2,
        top: cy * u - d / 2,
        width: d,
        height: d,
        borderTopWidth: w,
        borderRightWidth: w,
        borderColor: color,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

/**
 * A padlock's shackle: an arch, open at the bottom.
 *
 * Three borders on one box rather than a ring with something drawn over its
 * lower half, for the reason `chevron` gives — a corner joined by the layout
 * engine is a clean mitre at every size — and because the alternative needs a
 * *filled* body to hide what it covers. That would cost the lock its keyhole
 * and only work over an opaque ground, and these icons are drawn on a
 * translucent capsule.
 *
 * The top radius is half the box's width, so the two corners meet in a
 * semicircle rather than in two quarter-turns with a flat between them.
 */
function shackle(
  key: string,
  u: number,
  w: number,
  color: string,
  { x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number },
) {
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: x0 * u,
        top: y0 * u,
        width: (x1 - x0) * u,
        height: (y1 - y0) * u,
        borderTopWidth: w,
        borderLeftWidth: w,
        borderRightWidth: w,
        borderTopLeftRadius: ((x1 - x0) / 2) * u,
        borderTopRightRadius: ((x1 - x0) / 2) * u,
        borderColor: color,
      }}
    />
  );
}

/**
 * The mirror of `shackle`: an arch open at the **top**.
 *
 * A microphone's cradle, and the one shape the set could not make out of what
 * it had. It is not a rotated shackle — `transform` is applied after layout, so
 * a turned box lands somewhere else and the "stays inside its box" check in
 * `icons.test.ts` is then measuring a box the drawing has left. Three borders
 * and the two *bottom* radii, positioned where they are declared.
 */
function cradle(
  key: string,
  u: number,
  w: number,
  color: string,
  { x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number },
) {
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: x0 * u,
        top: y0 * u,
        width: (x1 - x0) * u,
        height: (y1 - y0) * u,
        borderBottomWidth: w,
        borderLeftWidth: w,
        borderRightWidth: w,
        borderBottomLeftRadius: ((x1 - x0) / 2) * u,
        borderBottomRightRadius: ((x1 - x0) / 2) * u,
        borderColor: color,
      }}
    />
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
  const drawn = draw(name, 24, "rgb(1, 2, 3)", 2);
  return (Array.isArray(drawn) ? drawn : [drawn]).map((stroke) => stroke.key);
}

/**
 * The drawing, as one or more absolutely-positioned strokes.
 *
 * The return type is written out rather than inferred: inferred, a `switch`
 * missing a case widens to `… | undefined` and compiles, which is the silent
 * empty box `ICON_NAMES` exists to catch. Written, the compiler catches it
 * first and the test is the second line of defence rather than the only one.
 */
function draw(name: IconName, u: number, c: string, w: number): ReactElement | ReactElement[] {
  switch (name) {
    case "panelLeft":
      return [
        rect("frame", u, w, c, { x0: 0.11, y0: 0.16, x1: 0.89, y1: 0.84, radius: 0.16 }),
        rect("pane", u, w, c, {
          x0: 0.11 + w / u,
          y0: 0.16 + w / u,
          x1: 0.37,
          y1: 0.84 - w / u,
          radius: 0.1,
          fill: c,
        }),
      ];

    case "search":
      return [
        ring("lens", u, w, c, { cx: 0.43, cy: 0.43, r: 0.26 }),
        // From the lens's lower-right edge to the corner, on the same 45° the
        // lens's centre lies on, so the handle reads as continuous with it.
        bar("handle", u, w, c, { cx: 0.74, cy: 0.74, length: 0.28, angle: 45 }),
      ];

    case "plus":
      return [
        bar("h", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62 }),
        bar("v", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62, angle: 90 }),
      ];

    case "check":
      return [
        bar("short", u, w, c, { cx: 0.325, cy: 0.625, length: 0.3, angle: 45 }),
        bar("long", u, w, c, { cx: 0.585, cy: 0.5, length: 0.6, angle: -48 }),
      ];

    case "close":
      return [
        bar("a", u, w, c, { cx: 0.5, cy: 0.5, length: 0.66, angle: 45 }),
        bar("b", u, w, c, { cx: 0.5, cy: 0.5, length: 0.66, angle: -45 }),
      ];

    case "chevronRight":
      return chevron("chevron", u, w, c, { cx: 0.44, cy: 0.5, side: 0.4, angle: 45 });
    case "chevronLeft":
      return chevron("chevron", u, w, c, { cx: 0.56, cy: 0.5, side: 0.4, angle: -135 });
    case "chevronDown":
      return chevron("chevron", u, w, c, { cx: 0.5, cy: 0.44, side: 0.4, angle: 135 });
    case "chevronUp":
      return chevron("chevron", u, w, c, { cx: 0.5, cy: 0.56, side: 0.4, angle: -45 });

    case "arrowLeft":
      return [
        bar("shaft", u, w, c, { cx: 0.52, cy: 0.5, length: 0.62 }),
        chevron("head", u, w, c, { cx: 0.34, cy: 0.5, side: 0.34, angle: -135 }),
      ];
    case "arrowRight":
      return [
        bar("shaft", u, w, c, { cx: 0.48, cy: 0.5, length: 0.62 }),
        chevron("head", u, w, c, { cx: 0.66, cy: 0.5, side: 0.34, angle: 45 }),
      ];

    case "more":
      return [
        dot("a", u, c, { cx: 0.19, cy: 0.5, r: 0.075 }),
        dot("b", u, c, { cx: 0.5, cy: 0.5, r: 0.075 }),
        dot("c", u, c, { cx: 0.81, cy: 0.5, r: 0.075 }),
      ];

    case "folder":
      return [
        // The tab, drawn as a bar so the body's rounded top-left corner is not
        // fighting a second rounded corner two points above it.
        bar("tab", u, w, c, { cx: 0.28, cy: 0.24, length: 0.26 }),
        rect("body", u, w, c, { x0: 0.12, y0: 0.24, x1: 0.88, y1: 0.8, radius: 0.12 }),
      ];

    case "file":
      /*
        Three rules of decreasing length, not two centred ones. Two lines
        centred in a tall rounded rectangle is a battery, which is what the
        first draft of this drew — a document is recognised by its *ragged*
        right edge, so the last rule is short and they sit above centre rather
        than around it.
      */
      return [
        rect("body", u, w, c, { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, radius: 0.11 }),
        bar("l1", u, w, c, { cx: 0.5, cy: 0.36, length: 0.3 }),
        bar("l2", u, w, c, { cx: 0.5, cy: 0.52, length: 0.3 }),
        bar("l3", u, w, c, { cx: 0.42, cy: 0.68, length: 0.14 }),
      ];

    case "constellation":
      return [
        bar("e1", u, w, c, { cx: 0.36, cy: 0.42, length: 0.36, angle: -40 }),
        bar("e2", u, w, c, { cx: 0.6, cy: 0.6, length: 0.44, angle: 42 }),
        dot("n1", u, c, { cx: 0.2, cy: 0.55, r: 0.1 }),
        dot("n2", u, c, { cx: 0.52, cy: 0.28, r: 0.1 }),
        dot("n3", u, c, { cx: 0.78, cy: 0.74, r: 0.1 }),
      ];

    case "exchange":
      return [
        bar("top", u, w, c, { cx: 0.46, cy: 0.34, length: 0.6 }),
        chevron("topHead", u, w, c, { cx: 0.66, cy: 0.34, side: 0.28, angle: 45 }),
        bar("bottom", u, w, c, { cx: 0.54, cy: 0.66, length: 0.6 }),
        chevron("bottomHead", u, w, c, { cx: 0.34, cy: 0.66, side: 0.28, angle: -135 }),
      ];

    /*
      Undo and redo share an arch — three chords of one circle, which is as
      much of an arc as a set drawn from rectangles gets — and differ only in
      which end carries the head. That is deliberate rather than lazy: a pair
      of icons that differ in their *whole* shape read as two unrelated marks,
      and a pair that differ in one end read as a direction, which is what
      these two are. The head is a quarter of the box wide so the difference
      survives the 20pt the accessory bar draws them at.
    */
    case "undo":
      return [
        bar("a1", u, w, c, { cx: 0.29, cy: 0.5, length: 0.28, angle: -60 }),
        bar("a2", u, w, c, { cx: 0.5, cy: 0.38, length: 0.28 }),
        bar("a3", u, w, c, { cx: 0.71, cy: 0.5, length: 0.28, angle: 60 }),
        chevron("head", u, w, c, { cx: 0.24, cy: 0.6, side: 0.28, angle: 180 }),
      ];
    case "redo":
      return [
        bar("a1", u, w, c, { cx: 0.29, cy: 0.5, length: 0.28, angle: -60 }),
        bar("a2", u, w, c, { cx: 0.5, cy: 0.38, length: 0.28 }),
        bar("a3", u, w, c, { cx: 0.71, cy: 0.5, length: 0.28, angle: 60 }),
        chevron("head", u, w, c, { cx: 0.76, cy: 0.6, side: 0.28, angle: 90 }),
      ];

    case "brackets":
      /*
        A stem plus two serifs each, rather than a `rect` with its middle
        hidden. The stems are 0.58 tall and not 0.7 because a bar is laid out
        horizontally and turned afterwards — its *declared* box is the
        horizontal one, so a vertical stroke at x is bounded by twice its
        distance from the nearer edge, and a taller pair would hang outside
        the box on paper even though it draws inside it.
      */
      return [
        bar("ls", u, w, c, { cx: 0.3, cy: 0.5, length: 0.58, angle: 90 }),
        bar("lt", u, w, c, { cx: 0.37, cy: 0.22, length: 0.14 }),
        bar("lb", u, w, c, { cx: 0.37, cy: 0.78, length: 0.14 }),
        bar("rs", u, w, c, { cx: 0.7, cy: 0.5, length: 0.58, angle: 90 }),
        bar("rt", u, w, c, { cx: 0.63, cy: 0.22, length: 0.14 }),
        bar("rb", u, w, c, { cx: 0.63, cy: 0.78, length: 0.14 }),
      ];

    case "tag":
      /*
        A luggage tag rather than Obsidian's diamond: the same shape turned
        45°, which `rect` cannot do, so it is drawn upright from its five
        edges. The eyelet sits at the flat end, where a tag's hole is, and the
        point is the end that would carry the string.
      */
      return [
        bar("flat", u, w, c, { cx: 0.26, cy: 0.5, length: 0.48, angle: 90 }),
        bar("top", u, w, c, { cx: 0.48, cy: 0.26, length: 0.44 }),
        bar("bottom", u, w, c, { cx: 0.48, cy: 0.74, length: 0.44 }),
        bar("p1", u, w, c, { cx: 0.8, cy: 0.38, length: 0.31, angle: 50 }),
        bar("p2", u, w, c, { cx: 0.8, cy: 0.62, length: 0.31, angle: -50 }),
        dot("eyelet", u, c, { cx: 0.42, cy: 0.5, r: 0.075 }),
      ];

    case "attach":
      /*
        Two nested capsules, not a clip's actual path, which doubles back on
        itself three times and is unreadable below about 28pt anyway. The
        outer one is wider than a paperclip really is because the gap between
        the two outlines has to survive a 2pt stroke at 20pt: any narrower and
        the inner capsule's hole closes up and the mark reads as a filled pill.
      */
      return [
        rect("outer", u, w, c, { x0: 0.16, y0: 0.06, x1: 0.84, y1: 0.94, radius: 0.34 }),
        rect("inner", u, w, c, { x0: 0.36, y0: 0.24, x1: 0.64, y1: 0.7, radius: 0.14 }),
      ];

    case "heading":
      return [
        bar("left", u, w, c, { cx: 0.3, cy: 0.5, length: 0.58, angle: 90 }),
        bar("right", u, w, c, { cx: 0.7, cy: 0.5, length: 0.58, angle: 90 }),
        bar("cross", u, w, c, { cx: 0.5, cy: 0.5, length: 0.4 }),
      ];

    case "bold":
      /*
        The two bowls overlap by exactly one stroke at the waist — the upper
        one's bottom edge and the lower one's top edge are the same band —
        because two rectangles merely stacked draw their shared line twice and
        a "B" with a middle bar at double weight is a "B" that has been sat on.
      */
      return [
        bar("stem", u, w, c, { cx: 0.31, cy: 0.5, length: 0.58, angle: 90 }),
        rect("upper", u, w, c, { x0: 0.27, y0: 0.21, x1: 0.62, y1: 0.5 + w / u / 2, radius: 0.1 }),
        rect("lower", u, w, c, { x0: 0.27, y0: 0.5 - w / u / 2, x1: 0.7, y1: 0.79, radius: 0.1 }),
      ];

    case "italic":
      return [
        bar("slant", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62, angle: -70 }),
        bar("top", u, w, c, { cx: 0.6, cy: 0.24, length: 0.26 }),
        bar("bottom", u, w, c, { cx: 0.4, cy: 0.76, length: 0.26 }),
      ];

    case "keyboardHide":
      /*
        A keyboard with a chevron *under* it rather than a keyboard alone: the
        key it stands for dismisses the keyboard, and a bare keyboard is the
        mark for summoning one. The lower row is a bar rather than three more
        dots, which is the space bar and is what stops the interior reading as
        a die face.
      */
      return [
        rect("body", u, w, c, { x0: 0.08, y0: 0.14, x1: 0.92, y1: 0.6, radius: 0.12 }),
        dot("k1", u, c, { cx: 0.26, cy: 0.3, r: 0.05 }),
        dot("k2", u, c, { cx: 0.5, cy: 0.3, r: 0.05 }),
        dot("k3", u, c, { cx: 0.74, cy: 0.3, r: 0.05 }),
        bar("space", u, w, c, { cx: 0.5, cy: 0.46, length: 0.34 }),
        chevron("head", u, w, c, { cx: 0.5, cy: 0.78, side: 0.26, angle: 135 }),
      ];

    case "share":
      /*
        Three nodes and two edges. The edges stop short of the discs rather
        than running under them — at 20pt a bar that reaches a node's centre
        turns the whole mark into a filled wedge — so each one is drawn a
        little shorter than the distance it spans and the gap does the rest.
      */
      return [
        bar("up", u, w, c, { cx: 0.5, cy: 0.34, length: 0.34, angle: -34 }),
        bar("down", u, w, c, { cx: 0.5, cy: 0.66, length: 0.34, angle: 34 }),
        dot("hub", u, c, { cx: 0.24, cy: 0.5, r: 0.13 }),
        dot("top", u, c, { cx: 0.76, cy: 0.2, r: 0.13 }),
        dot("bottom", u, c, { cx: 0.76, cy: 0.8, r: 0.13 }),
      ];

    case "book":
      return [
        rect("left", u, w, c, { x0: 0.08, y0: 0.2, x1: 0.48, y1: 0.82, radius: 0.1 }),
        rect("right", u, w, c, { x0: 0.52, y0: 0.2, x1: 0.92, y1: 0.82, radius: 0.1 }),
        bar("spine", u, w, c, { cx: 0.5, cy: 0.51, length: 0.62, angle: 90 }),
      ];

    case "gear":
      /*
        **The teeth lie across their radius, not along it.**

        They used to be radial spokes on a ring, which is a *sun* — and it was
        drawn at the foot of the file tree where Obsidian puts a settings gear,
        so that is what it was read as. A cog's teeth are stubs on the rim,
        perpendicular to the radius; that is the whole difference between the
        two marks, and it survives being drawn at 18pt.

        Eight, on the diagonals as well as the axes: at six the gaps are 60°
        apart and the mark reads as a flower. The rim sits inside them and a
        second ring is the hub, because a solid middle at this size fills in.
      */
      return [
        ring("rim", u, w, c, { cx: 0.5, cy: 0.5, r: 0.3 }),
        ring("hub", u, w, c, { cx: 0.5, cy: 0.5, r: 0.12 }),
        bar("t0", u, w, c, { cx: 0.86, cy: 0.5, length: 0.16, angle: 90 }),
        bar("t1", u, w, c, { cx: 0.755, cy: 0.755, length: 0.16, angle: 135 }),
        bar("t2", u, w, c, { cx: 0.5, cy: 0.86, length: 0.16 }),
        bar("t3", u, w, c, { cx: 0.245, cy: 0.755, length: 0.16, angle: 45 }),
        bar("t4", u, w, c, { cx: 0.14, cy: 0.5, length: 0.16, angle: 90 }),
        bar("t5", u, w, c, { cx: 0.245, cy: 0.245, length: 0.16, angle: 135 }),
        bar("t6", u, w, c, { cx: 0.5, cy: 0.14, length: 0.16 }),
        bar("t7", u, w, c, { cx: 0.755, cy: 0.245, length: 0.16, angle: 45 }),
      ];

    case "sort":
      /*
        The arrow is a stem with a head, on the leading third; the rules take
        the rest. Drawn shorter than `filter`'s so the two marks are not the
        same object with an arrow bolted on — this one is about *order*, and
        the descending stack says it in the space beside the arrow.
      */
      return [
        /*
          0.48, not 0.6. A bar is laid out horizontally and turned afterwards,
          so its *declared* box is the horizontal one and a vertical stroke at
          `cx` is bounded by twice its distance from the nearer edge — the same
          trap `brackets` documents, and the reason this stem is shorter than it
          looks like it should be.
        */
        bar("stem", u, w, c, { cx: 0.26, cy: 0.52, length: 0.48, angle: 90 }),
        chevron("head", u, w, c, { cx: 0.26, cy: 0.32, side: 0.24, angle: -45 }),
        bar("l1", u, w, c, { cx: 0.66, cy: 0.28, length: 0.44 }),
        bar("l2", u, w, c, { cx: 0.6, cy: 0.5, length: 0.32 }),
        bar("l3", u, w, c, { cx: 0.54, cy: 0.72, length: 0.2 }),
      ];

    case "lock":
      return [
        // The body sits under the shackle's legs rather than beside them, so
        // the two read as one object at 18pt.
        rect("body", u, w, c, { x0: 0.18, y0: 0.46, x1: 0.82, y1: 0.86, radius: 0.1 }),
        shackle("shackle", u, w, c, { x0: 0.32, y0: 0.16, x1: 0.68, y1: 0.5 }),
      ];

    case "lockOpen":
      // The same body with the shackle swung clear of it — off the body's axis
      // and raised, which is the whole difference between the two marks and
      // the only difference that survives being drawn this small.
      return [
        rect("body", u, w, c, { x0: 0.14, y0: 0.46, x1: 0.72, y1: 0.86, radius: 0.1 }),
        shackle("shackle", u, w, c, { x0: 0.5, y0: 0.12, x1: 0.86, y1: 0.46 }),
      ];

    case "globe":
      /*
        A ring with an equator and an axis, and no meridian ellipse.

        Feather's globe draws that third stroke as an ellipse, and this set has
        no way to: React Native's border radii do not make a reliable ellipse
        across both platforms, so it would have to be a stadium pretending to
        be one. The reasoning `filter` gives applies — at 20pt the difference
        between an ellipse and a straight axis is a smudge, and two crossed
        strokes inside a ring is unmistakably a globe where a fourth stroke is
        a scribble.

        The equator sits just above centre, where a globe's is when you are
        looking slightly down at one, which is the whole of what stops the two
        strokes reading as a crosshair.
      */
      return [
        ring("edge", u, w, c, { cx: 0.5, cy: 0.5, r: 0.38 }),
        bar("equator", u, w, c, { cx: 0.5, cy: 0.44, length: 0.72 }),
        bar("axis", u, w, c, { cx: 0.5, cy: 0.5, length: 0.72, angle: 90 }),
      ];

    case "collapse":
      /*
        A pane with a band across its top: everything folded up into the row it
        collapses to. The band is a filled bar rather than a second rectangle,
        because two nested outlines at 20pt is a smudge.
      */
      return [
        rect("frame", u, w, c, { x0: 0.12, y0: 0.18, x1: 0.88, y1: 0.82, radius: 0.14 }),
        bar("band", u, w * 1.6, c, { cx: 0.5, cy: 0.33, length: 0.5 }),
      ];

    case "filter":
      /*
        Three rules of decreasing length, not a funnel's outline. An outline
        needs two near-vertical strokes meeting at a point, and at 20pt that
        point is a blot; the stack says "narrowing" with nothing to blot.
      */
      return [
        bar("l1", u, w, c, { cx: 0.5, cy: 0.26, length: 0.7 }),
        bar("l2", u, w, c, { cx: 0.5, cy: 0.5, length: 0.44 }),
        bar("l3", u, w, c, { cx: 0.5, cy: 0.74, length: 0.2 }),
      ];

    case "mic":
      /*
        A capsule in a cradle, on a stem, on a base.

        The cradle's arms sit outside the capsule's sides (0.22/0.78 against
        0.34/0.66) rather than crossing it, which is what keeps the two reading
        as separate objects at 17pt instead of as one blot. The capsule's radius
        is half its own width, so it is a stadium rather than a rounded box —
        the same trick `radii.pill` plays on the toolbar, one drawing down.
      */
      return [
        rect("capsule", u, w, c, { x0: 0.34, y0: 0.1, x1: 0.66, y1: 0.6, radius: 0.16 }),
        cradle("cradle", u, w, c, { x0: 0.22, y0: 0.42, x1: 0.78, y1: 0.72 }),
        bar("stem", u, w, c, { cx: 0.5, cy: 0.8, length: 0.12, angle: 90 }),
        bar("base", u, w, c, { cx: 0.5, cy: 0.88, length: 0.3 }),
      ];
  }
}

const styles = StyleSheet.create({
  box: { position: "relative" },
});
