import { Platform } from "react-native";

/**
 * Design tokens for Context.
 *
 * ## Graphite and Paper
 *
 * The palettes are warm neutrals — Graphite in the dark, Paper in the light —
 * and they replace a ramp of blue-blacks whose every accent was a Tailwind
 * default (`#3B82F6` blue-500, `#34D399` emerald-400, `#FBBF24` amber-400,
 * `#F87171` red-400, `#8B5CF6` violet-500). That is worth naming as the reason
 * rather than as trivia: a palette assembled from a framework's defaults looks
 * like every other application assembled from them, and no amount of layout
 * work recovers from it. The product is plain files somebody owns, so the
 * ground is paper and graphite and the greys carry warmth rather than a cast
 * borrowed from a CSS framework.
 *
 * ## Hue is meaning here, so it is rationed
 *
 * Five hues, each with exactly one job, placed far enough apart on the wheel
 * that no two can be confused at a glance:
 *
 *   - **petrol** (`accent`, `hint*`, `codeKey`) — here, active, yours. Never a
 *     status. It is the only hue the interface spends on itself.
 *   - **sage** (`ok*`) — synced, saved, bound.
 *   - **amber** (`warn*`, `warm`) — degraded but working.
 *   - **rust** (`crit*`) — conflict, revoked, failed.
 *   - **iris** (`shared*`, `graphColors.shared`) — somebody else's context.
 *
 * `private` — the default state of everything in this product — wears no hue
 * at all, which is why the neutral ramp has to do real work and has four steps
 * in each palette rather than two near-identical ones.
 *
 * Both palettes are a **design**, not an inversion of one another — see
 * `lightColors` for where they deliberately diverge and why. Every colour is
 * painted explicitly so nothing borrows a host background.
 *
 * Neither palette is a module-level global any more. Screens obtain one
 * through `useColors()` / `useThemedStyles()` in `./theme`; non-React code
 * takes a `Colors` as an argument. Importing a palette by name is for the
 * tokens themselves, for tests, and for nothing else — a `StyleSheet.create`
 * that closes over one is a screen that can never change appearance, and that
 * is exactly the bug this file used to guarantee.
 */
export const darkColors = {
  ground: "#100F0E",
  surface: "#191715",
  /**
   * `surface` at zero alpha, for the one thing that needs to fade *to* it.
   *
   * A gradient needs both ends, and "transparent" is not one of them: CSS
   * interpolates an unqualified `transparent` through `rgba(0,0,0,0)`, so a
   * fade from it to a light surface passes through grey and reads as a smudge
   * — the classic dirty-gradient. It is written as the surface's own channels
   * at zero rather than derived, because there is no colour arithmetic in this
   * file and adding some for one token is a worse trade than two literals a
   * test can compare.
   */
  surfaceClear: "rgba(25,23,21,0)",
  surface2: "#201E1B",
  surface3: "#2B2825",

  /**
   * The resting fill of a small control sitting on chrome.
   *
   * The design canvas gives the switcher chip, the search box and the tree's
   * "new note" button the same barely-there wash at rest, and it is the thing
   * that makes the title bar read as a row of controls rather than a row of
   * floating words. It is the ground's own ink at 5% rather than `surface2`,
   * so it works on both `chromeSurface` and `pageSurface` without either
   * having to know what is drawn on it.
   */
  chipFill: "rgba(237,232,224,0.05)",

  /**
   * Chrome's grey, which is one step quieter than a label's.
   *
   * `muted` is what a *name* is drawn in — a folder in the tree, a row in a
   * menu. This is what the furniture around it is drawn in: a chevron, an
   * eyebrow, a status segment, the ✕ on a tab. The canvas uses two greys and
   * collapsing them to one is what made the earlier chrome read as loud.
   */
  chromeMuted: "#8D857B",

  /** A selected row in the file tree, under its accent bar. */
  rowSelected: "#2B2825",

  /**
   * THE APPLICATION, AS DEPICTED INSIDE A PAGE THAT IS NOT IT.
   *
   * Two objects on the landing page are graphite in **both** palettes, and the
   * design canvas is explicit about it: the endpoint bar — the MCP address you
   * copy into a client — and the hero's application window are drawn dark on
   * `Landing-Hero`'s paper board as well as its dark one.
   *
   * They are *depictions of software*, quoted inside a page that is not that
   * software. A terminal is a dark thing; a screenshot of an application is a
   * screenshot, whatever the brochure around it is made of. Re-tinting either
   * to paper gives a slightly different paper, which is not a different kind of
   * thing — and is what makes an embedded window read as a section of the
   * website instead of as the product.
   *
   * Tokens rather than hexes at the call site because
   * `paletteDiscipline.test.ts` is right: a component that names a colour is a
   * component no palette can answer for, and "this one is meant to be fixed" is
   * exactly the claim that needs to live where a reviewer will find it.
   *
   * **Two objects, and the rule is about what a thing *is*.** A third fixed
   * dark box is not covered by "the other two do it"; anything genuinely part
   * of the page inverts. Argued at length in `docs/decisions/app-and-console.md`,
   * "A picture of the application does not invert with the page it sits on".
   */
  appSurface: "#201E1B",
  appInk: "#EDE8E0",
  appAccent: "#6BC8C1",
  appChip: "rgba(237,232,224,0.09)",
  appChipHover: "rgba(237,232,224,0.16)",
  appChrome: "#191715",
  appMuted: "#A79F95",
  appDim: "#8D857B",
  appBody: "#D8D2C9",
  appRowSelected: "#2B2825",
  appTeam: "#B9A3F2",
  appOk: "#82C98E",
  /*
    A window's own controls, which belong to an operating system rather than to
    this product: the three macOS drew, in a picture of a macOS window. They are
    tokens for the same reason the rest are — a component may not name a colour
    — and they are the one group here that is not this palette's at all.
  */
  appLightRed: "#FF5F57",
  appLightAmber: "#FEBC2E",
  appLightGreen: "#28C840",

  /**
   * The `team` marker in the file tree, and only that.
   *
   * Visibility is the one thing a row says about itself that is not about the
   * file, and the canvas gives it its own hue rather than another grey: down a
   * column of muted words, a second muted word is furniture, and this one is a
   * fact about who can read what. It is the same violet the constellation map
   * already uses for a shared edge (`darkGraphColors.shared`), written again
   * rather than imported — the map's palette is keyed by *relationship* and
   * this is keyed by *visibility*, and a shared import would tie two meanings
   * together that are free to move apart.
   */
  markTeam: "#B9A3F2",

  /** Hairline separators. RN has no `currentColor`, so these are literal rgba. */
  line: "rgba(237,232,224,0.07)",
  lineStrong: "rgba(237,232,224,0.14)",

  text: "#EDE8E0",
  text2: "#C3BCB2",
  muted: "#A79F95",
  /** The second hero line, deliberately dimmer than `muted`. */
  heroDim: "#7A736A",

  accent: "#6BC8C1",
  accentDim: "rgba(107,200,193,0.13)",
  accentText: "#A9DEDA",

  ok: "#82C98E",
  okText: "#A6DBAE",
  okWash: "rgba(130,201,142,0.10)",
  okBorder: "rgba(130,201,142,0.22)",

  warn: "#DFAC52",
  warnText: "#E9C47E",
  warnWash: "rgba(223,172,82,0.10)",
  warnBorder: "rgba(223,172,82,0.22)",

  crit: "#F08C7C",
  critText: "#F5B0A4",
  critBorder: "rgba(240,140,124,0.24)",
  critWash: "rgba(240,140,124,0.09)",

  /**
   * Iris — "somebody else's access" — `graphColors.shared`'s family, as a
   * wash and a label.
   *
   * It is the one hue in the budget that is not warm, and deliberately: a
   * context that is not yours should not sit in the same family as the paper
   * it is drawn on. Tokens rather than the two literals that used to sit in
   * `ContinuityDemo.tsx`, because a hardcoded value legible on one ground is
   * invisible on the other, and a colour with no token is a colour no palette
   * can answer for.
   */
  sharedWash: "rgba(185,163,242,0.13)",
  sharedText: "#CEBCF7",
  /**
   * The edge of that wash, for the one place the wash alone cannot carry it:
   * the pinned context's pill on the phone strip, which takes the lit pill's
   * accent ground on top of `sharedWash` when somebody is standing in it. The
   * border and the label are what go on saying whose context it is.
   *
   * Same alpha relationship the `ok`/`warn`/`crit` families use between their
   * own wash and border, so it sits in the palette rather than beside it.
   */
  sharedBorder: "rgba(185,163,242,0.30)",

  /** Inverse ink, used on the white CTA and on the "You" node in the map. */
  /**
   * The two surfaces the application frame is built from.
   *
   * The rail, the explorer and the editor were all `surface` — one value, three
   * regions — so nothing separated them and a hairline border had to be drawn
   * between each pair. That is the shape the whole redesign argues against: a
   * line doing work that a value should do, three times, down the middle of the
   * screen.
   *
   * They cannot be spelled `surface`/`surface2` at the call site, because those
   * two move in **opposite directions** in the two palettes — `surface2` is a
   * darker tint on paper and a lighter one on graphite — and the rule here is
   * the same in both: **the page is lighter than the chrome around it**, the way
   * paper is lighter than the desk. Naming the roles rather than the tints is
   * what lets one assignment be right in both themes.
   */
  chromeSurface: "#191715",
  pageSurface: "#201E1B",

  ink: "#100F0E",
  white: "#EDE8E0",

  /** The near-black used for insets: code blocks, the map field, field values. */
  well: "#0A0908",

  /** Warm accent for the first floating tile's mark. */
  warm: "#DFAC52",

  hintWash: "rgba(107,200,193,0.06)",
  hintBorder: "rgba(107,200,193,0.16)",
  hintText: "#A9DEDA",
  hintStrong: "#CCEBE8",

  /** Syntax tints in the note preview. */
  codeKey: "#8FD3CE",

  /* ------------------------------------------------------------------ *
   * Floating chrome.
   *
   * On a phone the controls are not a bar with a rule under it — they are
   * objects lying over the note, the way Obsidian mobile draws them. That
   * needs a surface that reads as *above* `surface` without a border to say
   * so, because a border is exactly what a floating object does not have.
   * `surface3` is the hover tint for a row inside a panel and is too close to
   * its own ground to carry an edge on its own; these two are a step further
   * out, and the shadow underneath does the rest.
   * ------------------------------------------------------------------ */
  chrome: "#262421",
  chromePressed: "#322E2A",

  /**
   * The wash over the editor while a panel is out.
   *
   * A token rather than the literal `rgba(0,0,0,.6)` that used to sit in
   * `AppFrame`, because the right answer is not the same in the two worlds. On
   * this ground a scrim has to be heavy: it is dark over dark, and anything
   * lighter fails to separate the panel from the note behind it. In a light
   * world the same value is a blackout — the note goes to near-black behind a
   * white sheet, which is a modal dialog's weight for a file tree you flick in
   * and out of a dozen times an hour. Obsidian barely tints it.
   */
  scrim: "rgba(10,9,8,0.60)",
} as const;

/**
 * The shape both palettes share.
 *
 * Deliberately `Record<keyof typeof darkColors, string>` rather than
 * `typeof darkColors`: the latter carries the dark literals, so a light
 * palette could only satisfy it by being the dark one. This form still makes
 * a missing key a compile error and an invented key an excess-property error,
 * which is the property that matters — a token that exists in one palette and
 * not the other resolves to `undefined`, and `undefined` in `backgroundColor`
 * is a transparent view rather than a crash.
 */
export type Colors = Readonly<Record<keyof typeof darkColors, string>>;

/**
 * The light palette.
 *
 * Designed against the dark one rather than derived from it. Three notes on
 * where a mechanical inversion would have been wrong:
 *
 * **The elevation stack is re-ranked, on purpose.** In the dark palette
 * `ground < surface < surface2 < surface3` ascend in lightness, because there
 * both *elevation* (a panel lifts off the page) and *interaction* (a row tints
 * under the pointer) move the same way: towards light. In a light world they
 * move in opposite directions — a raised panel goes towards white, a hovered
 * row goes towards grey — so no single lightness ranking can carry both roles.
 * The tokens are therefore placed by the job each one does, which is the
 * relationship worth preserving:
 *
 *   - `ground` is the page.
 *   - `surface` is the panel on it.
 *   - `surface2` is the faint fill: a pointer layout's toolbar, a raised card.
 *   - `surface3` is the stronger tint: a menu row under the pointer, a ghost
 *     button's fill, a neutral pill, a selected row on a phone.
 *   - `well` stays the deepest inset, as it is in the dark palette.
 *
 * **`ground` and `surface` are the same paper tone, and that is the design
 * rather than a value nobody filled in.** This palette used to ground at `#EDEDF2` with
 * `#14141A` ink so that a white panel could lift off the page without a
 * border. On a desktop that is a defensible picture and on a phone it is the
 * single thing that made the app read as grey: the note, the file tree and the
 * chrome are each the widest object on the glass, there is nothing for them to
 * lift *off*, and the grey shows through as a tint over the whole document.
 * Obsidian on iOS — which is the surface this app is measured against, and
 * which most of its users already have open — paints paper white and separates
 * regions with a shadow and a hairline instead. So do we. The hairlines
 * (`line`) and the three shadows are what carry the separation now, which is
 * why neither may be dropped as "invisible": on this ground they are the only
 * edges there are.
 *
 * **`white` and `ink` keep their roles, not their names.** `white` is the
 * primary CTA's fill and `ink` is the label on it; in the dark world that is a
 * near-white button with near-black text. Inverting the world inverts the
 * button, so here `white` is near-black and `ink` is white. The names read as
 * lies in this half of the file and the values are still right — renaming them
 * would touch every call site for no behavioural gain, so the roles are
 * documented instead.
 *
 * **Pressed states darken rather than lighten.** `chromePressed` is lighter
 * than `chrome` in the dark palette and darker than it here. Both mean the
 * same thing — more ink under the thumb — and following the dark direction
 * would have made a pressed control brighter than the white it sits on, which
 * is not a press.
 *
 * Contrast is asserted, not asserted-in-prose: see `__tests__/theme.test.ts`.
 */
export const lightColors: Colors = {
  ground: "#FFFDF9",
  surface: "#FFFDF9",
  /** `surface` at zero alpha. See the dark palette's own note. */
  surfaceClear: "rgba(255,253,249,0)",
  surface2: "#F7F4ED",
  surface3: "#F0ECE3",

  /** See the dark palette: the ground's ink at 5%, so it works on either surface. */
  chipFill: "rgba(26,23,20,0.05)",
  /** See the dark palette's note. Light's `heroDim` happens to be the same grey. */
  chromeMuted: "#7A7264",
  /**
   * Deliberately darker than `surface3`.
   *
   * A selected row has to hold at a glance across a 260pt column of names, and
   * on paper `surface3` at `#F0ECE3` is a tint you have to look for. The canvas
   * draws it two steps down.
   */
  rowSelected: "#E6E1D6",

  /** Identical to the dark palette's, deliberately — see its note. */
  appSurface: "#201E1B",
  appInk: "#EDE8E0",
  appAccent: "#6BC8C1",
  appChip: "rgba(237,232,224,0.09)",
  appChipHover: "rgba(237,232,224,0.16)",
  appChrome: "#191715",
  appMuted: "#A79F95",
  appDim: "#8D857B",
  appBody: "#D8D2C9",
  appRowSelected: "#2B2825",
  appTeam: "#B9A3F2",
  appOk: "#82C98E",
  /*
    A window's own controls, which belong to an operating system rather than to
    this product: the three macOS drew, in a picture of a macOS window. They are
    tokens for the same reason the rest are — a component may not name a colour
    — and they are the one group here that is not this palette's at all.
  */
  appLightRed: "#FF5F57",
  appLightAmber: "#FEBC2E",
  appLightGreen: "#28C840",
  /** See the dark palette's note. */
  markTeam: "#6A46B8",

  /** Hairline separators — black at low alpha, mirroring the dark palette's white. */
  line: "rgba(26,23,20,0.09)",
  lineStrong: "rgba(26,23,20,0.18)",

  /**
   * Ink, and its two quieter voices.
   *
   * A warm near-black rather than a neutral or blue-cast one. The earlier
   * value was `#222222`, chosen to stop a cool cast fighting a grey-blue
   * ground; now that the ground is paper, the ink is warmed to sit in the same
   * family rather than merely stop clashing with it. The difference is small
   * per character and unmissable over a page of prose, which is what this
   * colour is mostly used for.
   */
  text: "#1A1714",
  text2: "#4A443C",
  muted: "#635C52",
  /** The second hero line, deliberately dimmer than `muted`. */
  heroDim: "#7A7264",

  accent: "#0E6C69",
  accentDim: "rgba(14,108,105,0.10)",
  accentText: "#0A5350",

  ok: "#3E7A4E",
  okText: "#2C5C39",
  okWash: "rgba(62,122,78,0.10)",
  okBorder: "rgba(62,122,78,0.28)",

  warn: "#96600A",
  warnText: "#7A4E08",
  warnWash: "rgba(150,96,10,0.12)",
  warnBorder: "rgba(150,96,10,0.30)",

  crit: "#B23A2B",
  critText: "#962E21",
  critBorder: "rgba(178,58,43,0.28)",
  critWash: "rgba(178,58,43,0.08)",

  sharedWash: "rgba(106,70,184,0.10)",
  sharedText: "#55329E",
  sharedBorder: "rgba(106,70,184,0.30)",

  /** See the note above: the CTA fill is dark here, and its ink is white. */
  /** See `darkColors.chromeSurface`: the page stays lighter than its chrome. */
  chromeSurface: "#F4F1EA",
  pageSurface: "#FFFDF9",

  ink: "#FFFDF9",
  white: "#1A1714",

  /**
   * The recessed grey used for insets: code blocks, the map field, field
   * values — and, in a note, the ground under an inline `code` span, which is
   * where most people will actually see it.
   */
  well: "#EDE9E1",

  /** Warm accent for the first floating tile's mark. */
  warm: "#B5761C",

  hintWash: "rgba(14,108,105,0.06)",
  hintBorder: "rgba(14,108,105,0.22)",
  hintText: "#0E6C69",
  hintStrong: "#0A4442",

  /** Syntax tints in the note preview. */
  codeKey: "#0A5350",

  /**
   * Floating chrome. A floating object in a light world is white and reads as
   * above the page through its shadow rather than through being brighter than
   * everything under it — there is nothing brighter than white.
   */
  chrome: "#F4F1EA",
  chromePressed: "#E4DFD4",

  /** See the dark palette's note: a tint here, not a blackout. */
  scrim: "rgba(26,23,20,0.22)",
};

/** Edge/node colours in the constellation map, keyed by relationship. */
export const darkGraphColors = {
  own: "#6BC8C1",
  team: "#A79F95",
  shared: "#B9A3F2",
  client: "#82C98E",
  you: "#EDE8E0",
} as const;

export type GraphKind = keyof typeof darkGraphColors;

export type GraphColors = Readonly<Record<GraphKind, string>>;

/**
 * The same five relationships, at light-mode contrast.
 *
 * `you` follows `white`/`ink`: it is the emphasised node, so it is the one
 * disc drawn in the ground's opposite — near-black here, near-white there.
 */
export const lightGraphColors: GraphColors = {
  own: "#0E6C69",
  team: "#635C52",
  shared: "#6A46B8",
  client: "#3E7A4E",
  you: "#1A1714",
};

/**
 * Font families.
 *
 * On web these are CSS font stacks — the faces themselves are pulled from
 * Google Fonts (see `fonts.web.ts` and `public/index.html`), exactly as the mockup
 * does. On native we deliberately hand back `undefined` so the platform
 * default is used: passing a comma-separated stack to a native text node is
 * meaningless on iOS and can throw on Android, and there are no bundled font
 * binaries to point at yet. Native is a later surface; see the report.
 */
const webStack = (primary: string, fallback: string) => `${primary}, ${fallback}`;

export const fonts = {
  /**
   * The display voice.
   *
   * It was Onest, a second sans bought and shipped alongside the body face —
   * and nothing in a console is set large enough to tell two humanist sans
   * apart. The two faces differed by about a point and a half of width per
   * hundred pixels and by nothing a reader would name, so the second webfont
   * was a download that bought no identity.
   *
   * `display` stays as a token because the *role* is real: a wordmark, a hero,
   * a pane title and a legal page's headings want one voice and the interface
   * wants another, and keeping the name means that distinction can be given a
   * face again later without touching a call site. It just resolves to the
   * body face now, and the difference between display and interface is carried
   * by size, weight and tracking instead.
   */
  display: Platform.select({
    web: webStack(
      "Instrument Sans",
      "ui-sans-serif, system-ui, -apple-system, sans-serif",
    ),
    default: undefined,
  }),
  body: Platform.select({
    web: webStack(
      "Instrument Sans",
      "ui-sans-serif, system-ui, -apple-system, sans-serif",
    ),
    default: undefined,
  }),
  mono: Platform.select({
    web: webStack("JetBrains Mono", "ui-monospace, SFMono-Regular, Menlo, monospace"),
    default: Platform.select({ ios: "Menlo", default: "monospace" }),
  }),
} as const;

/**
 * The type scale.
 *
 * ## Why this file did not have one, and what that cost
 *
 * Colour, radii, spacing and shadows were all tokenised here and type was not,
 * so every screen picked its own size. The result, counted across `features/`
 * and `app/`: **26 distinct font sizes**, drifting in half-points — 10, 10.5,
 * 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17 and up. That
 * is not a scale, it is a ramp with every rung on it, and it is the single
 * largest reason two panels built by two different hands never looked related.
 *
 * Nine sizes, integers only. Half-points were never a design decision; they
 * are what happens when somebody nudges a number until one screen looks right,
 * and they blur on any display that is not 2x.
 *
 * ## Two densities, one scale
 *
 * A phone is not this scale shrunk. `pointerType` and `touchType` are the same
 * nine roles at two sizes, and `typeFor(density)` picks one — the same shape as
 * `radii`'s pointer/phone split, which this file already argued for and which
 * was previously expressed as three lonely radius values.
 *
 * Note that `title` gets **smaller** on a phone, not larger: the measure it has
 * to fit into is roughly 342pt rather than 640, and a title that wraps to three
 * lines is not emphatic, it is in the way.
 */
export const pointerType = {
  /** Uppercase section labels, tracked +0.08em, weight 600. */
  label: 11,
  /** Counts, timestamps, paths, anything a row says about itself. */
  meta: 12,
  /** The default: tree rows, tabs, buttons, menu items, fields. */
  ui: 13,
  /** Settings prose, dialog bodies, empty states. */
  lede: 15,
  /** The note. Set against `layout.readingMeasureEm`. */
  body: 16,
  h3: 19,
  h2: 23,
  /** A note title. */
  title: 30,
  /** Marketing and first-run only; nothing in the console is this size. */
  display: 40,
} as const;

export type TypeScale = Readonly<Record<keyof typeof pointerType, number>>;

export const touchType: TypeScale = {
  label: 11,
  meta: 12,
  ui: 16,
  lede: 17,
  body: 17,
  h3: 20,
  h2: 22,
  title: 28,
  display: 46,
};

/**
 * The scale for a density.
 *
 * `compact` is the phone — see `features/app/frame.ts`, which owns the word.
 * The two wider densities are pointer densities and share one scale: a medium
 * window is a narrower desktop, not a larger phone.
 */
export function typeFor(density: "compact" | "medium" | "wide"): TypeScale {
  return density === "compact" ? touchType : pointerType;
}


export const radii = {
  /* ------------------------------------------------------------------ *
   * Three corners, and a pill.
   *
   * These eleven names used to hold nine values — 6, 7, 8, 9, 10, 11, 12, 13,
   * 16, 26 — which is a ramp rather than a family: no two of them read as
   * related, and a row at 7 inside a card at 12 inside a panel at 13 has three
   * corners that disagree by a point each, which is exactly close enough to
   * look like a mistake and not close enough to look like a decision.
   *
   * The names are kept, because they say where a radius belongs and there are
   * call sites for all of them. What changed is that they now resolve to three
   * values chosen to nest:
   *
   *   **inner 6** — a row, a chip, an input, a small button.
   *   **container 10** — a card, a panel, a menu, a popover.
   *   **outer 16** — a window, a dialog, anything that is the widest thing on
   *   the screen.
   *
   * The nesting rule is that a child's radius is its parent's minus the
   * padding between them: 16 − 6 = 10, 10 − 4 = 6. Concentric corners are the
   * difference between nested panels looking drawn and looking stacked.
   * ------------------------------------------------------------------ */
  xs: 6,
  sm: 6,
  md: 6,
  lg: 6,
  xl: 10,
  card: 10,
  panel: 10,
  cta: 10,
  console: 16,
  tile: 16,
  pill: 999,

  /* ------------------------------------------------------------------ *
   * Phone geometry.
   *
   * The radii above are a pointer application's: 6–16, drawn small because a
   * 13px row inside a 12px card inside a 16px panel has to nest three
   * corners inside 40px of height. A phone nests nothing — a sheet, a
   * toolbar and a grouped card are each the widest thing on the screen — so
   * they are drawn at the scale iOS and Obsidian mobile draw them at, and
   * using the pointer scale there is the single loudest way a phone layout
   * reads as a shrunken desktop.
   * ------------------------------------------------------------------ */
  /** A grouped list card, and the drawer's trailing corners. */
  sheet: 18,
  /** The floating toolbar and anything else lying over the note. */
  floating: 20,
  /** A control on a phone: a circular button is `pill`, a square one is this. */
  control: 14,
} as const;

export const space = {
  x1: 4,
  x2: 8,
  x3: 12,
  x4: 16,
  x5: 20,
  x6: 24,
  x7: 28,
  x8: 32,
} as const;

/**
 * The touch minimum, hoisted so `layout` can derive from it.
 *
 * A `const` object cannot reference its own members while it is being built,
 * and the alternative — writing `44` twice and claiming in a comment that the
 * two agree — is exactly the shape this repo keeps getting bitten by.
 */
const MIN_TOUCH_TARGET = 44;

/** The mockup's `.wrap`: `max-width:1200px; padding:0 28px`. */
export const layout = {
  maxWidth: 1200,
  gutter: 28,
  /** `@media(max-width:880px)` — rail goes horizontal, browse goes single column. */
  narrowBreakpoint: 880,
  /** `@media(max-width:1080px)` — floating tiles are hidden. */
  tileBreakpoint: 1080,
  railWidth: 216,
  /**
   * The settings overlay's index, which is wider than the rail it used to
   * borrow its width from.
   *
   * 216 is a column of bare labels. This one carries a mark, a label and what
   * the setting is currently *set to* — and at 216 the value had about 33pt
   * left, which is not a column, it is an ellipsis. The panel beside it is
   * capped at 940, so the 36 points come out of a body that has them.
   */
  settingsListWidth: 252,
  treeWidth: 246,
  consoleBodyMinHeight: 566,
  mapHeight: 398,

  /**
   * The reading measure — how long a line of the note's own prose may get
   * before it is hard to read — as a multiple of the note's own font size.
   *
   * Typography's "measure" is line length, and this is the only number in this
   * file that is not in points, because the constraint is not a width: the eye
   * loses the start of the next line somewhere past about 75 characters, and a
   * 1440px console pane was giving a real paragraph roughly 150. Relative to
   * the type, because a measure stated as a multiple of the note's own size is
   * the same sentence whatever that size is — both densities draw 16px today,
   * and this does not have to be revisited if either ever stops.
   *
   * ## Why `em` and not `ch`, which is the unit that means "characters"
   *
   * `ch` is the advance of the digit zero, and a digit is a poor proxy for
   * prose: the zero-to-lowercase ratio is itself a property of the face, so a
   * `ch` measure varies with *two* font metrics where an `em` measure varies
   * with one. Measured, not theorised — this shipped as `62ch` and CI caught
   * it: 75 characters a line in Chromium, **91** in WebKit on the same Linux
   * runner, because the fallback face there draws a wide zero over narrow
   * lowercase. Same declaration, same viewport, sixteen characters apart.
   *
   * (`ch` was ambiguous in a second way, which is worth knowing even though it
   * is no longer the unit: a font-relative length in a custom property can be
   * resolved either where the property is declared or where it is used, and
   * engines differ. The note's wrapper is Times New Roman at 16px and the note
   * is a sans at 14.5px, so the two answers were different lengths. The value
   * is therefore a bare number here and gets its unit at the point of use, in
   * the rule that draws the text — see `--lp-measure` in `LiveEditor.web.tsx`.)
   *
   * ## 40
   *
   * Measured at 1440x900 in a browser rather than trusted as arithmetic: 40em
   * is 580px in the console's own face. English prose in a system sans
   * averages 0.45-0.55em a character, so 40 lands between about 73 and 89
   * across faces.
   *
   * This was 36 (522px, 68 characters) on the reasoning that the comfortable
   * band is 60-75 and erring short is the cheaper error. The owner compared it
   * against Obsidian, which is the app people arrive here from, and short read
   * as *too* short. Measuring Obsidian's own reading measure settled it: in a
   * 1010px pane it draws 582px of text, against our 522px in a pane of the
   * same width — a tenth narrower, in the one place a reader has something to
   * compare us to. 40em is 580px, which is that number.
   *
   * The lower bound of the readable band is not the target. A measure is
   * comfortable across a range, and inside that range the tie is broken by
   * what the reader already knows; being conspicuously narrower than the
   * editor somebody used yesterday is a cost the band does not price.
   *
   * It is deliberately one value for both densities: on a phone the note is
   * 342pt of text inside 24pt gutters, which is far narrower than 40em at
   * 16px, so the measure cannot bind there and the padding governs. Two values
   * would be two things to keep in step for no gain.
   */
  readingMeasureEm: 40,

  /**
   * The gutter the web editor's scroller keeps either side of the measure.
   *
   * `LiveEditor.web.tsx` spends it as `.cm-scroller`'s horizontal padding, and
   * the measure is centred *inside* what is left — so anything that has to
   * start at the same character as the note's first line adds this to half the
   * remainder. `noteGutterFor` in `features/app/frame.ts` is that arithmetic,
   * in one place, and the breadcrumb above the note is what asks for it.
   *
   * The WebView half (`files/webview/styles.ts`) sets `--lp-pad-x: 24`, and
   * that is a different number for a different surface rather than drift: it
   * is a phone's reading margin, where the measure never binds and the gutter
   * is the whole of what governs the column.
   */
  notePadX: 16,

  /**
   * The note's own type size, in the web editor.
   *
   * Set on `.cm-scroller` in `LiveEditor.web.tsx`, and the unit
   * `readingMeasureEm` is multiplied by — so it is half of what decides where
   * the column's edges are, and `noteGutterFor` needs both.
   */
  noteFontSize: 16,

  /* ---------------------------------------------------------------------- *
   * The application frame.
   *
   * These belong to `features/app/frame.ts`, which decides which regions are
   * on screen at a given width. They live here rather than there for the same
   * reason every other measure does: a number that decides a layout should be
   * readable beside the other numbers that decide layouts.
   * ---------------------------------------------------------------------- */

  /** Above this the rail can afford its labels and everything is visible. */
  wideBreakpoint: 1180,
  /** The rail reduced to its marks, for a medium window. */
  railIconWidth: 56,
  /**
   * The right panel's resting width, and the range a drag may take it to.
   *
   * Wider than the tree at rest, and deliberately: the tree holds file names
   * and this holds a conversation, and a chat column under about 300pt turns
   * every answer into a ladder. The ceiling is where the note's own measure
   * starts to suffer on a 1180pt window, which is the narrowest layout that
   * draws this as a column at all.
   */
  asideWidth: 340,
  asideMinWidth: 300,
  asideMaxWidth: 520,
  /** The explorer column's resting width, and the range a drag may take it to. */
  explorerWidth: 260,
  explorerMinWidth: 200,
  explorerMaxWidth: 460,
  /**
   * How far past the floor a drag has to go before releasing folds the column
   * away instead of snapping back to it.
   *
   * `clampExplorerWidth` still refuses to *render* anything narrower than
   * `explorerMinWidth` — the floor is where a kebab-case name under two indents
   * stops being readable, and that has not changed. What changes is what
   * happens when somebody keeps pulling: the drag arms a close rather than
   * meeting a wall. 28 is far enough that overshooting the floor by a few
   * pixels does not close the tree by accident, and near enough that a
   * deliberate pull reaches it without a shove.
   */
  explorerCloseOvershoot: 28,
  /**
   * The seam between two panels: a hairline that is also a 7pt target.
   *
   * Wide enough to hit without looking, narrow enough to read as the rule it
   * draws. The closed seam is wider because it is the only thing left standing
   * where a whole panel was, and it is the control that brings the panel back.
   */
  seamWidth: 7,
  /**
   * How far the tree's drag handle reaches past the column, over the editor.
   *
   * A 7pt strip centred on a 1pt border: three points of it lie over the
   * editor, three over the tree. People aim at the edge rather than a few
   * points inside it, so a handle that stopped at the border would refuse
   * about half the grabs aimed at it — which is why the frame draws this
   * *after* the editor rather than inside the column (see `AppFrame`).
   */
  explorerSeamOverhang: 3,
  seamClosedWidth: 10,
  /** The chevron pill centred on a seam, revealed under the pointer. */
  seamPillWidth: 18,
  seamPillHeight: 42,
  /**
   * The warm strip down the leading edge in focus mode.
   *
   * Nothing is drawn in it. It exists so that a pointer sent to the edge of the
   * window — which is where a hand goes looking for a panel that was there a
   * moment ago — finds something rather than the note.
   */
  focusEdgeWidth: 12,
  /**
   * The smallest target a thumb can be asked to hit, in points.
   *
   * 44 is Apple's HIG minimum and Android's 48dp rounds down to about the same
   * physical size. It lives here rather than in the one component that first
   * needed it because it is not the bottom bar's rule — it is the rule for
   * every control a phone offers, and the top bar's navigation control is one.
   * `BottomBar` re-exports it as `MIN_TOUCH_TARGET` so its tests keep asserting
   * the same number the styles use.
   *
   * Not yet universal: `Menu`, `Menu.web` and `Palette` still type `44` for
   * this same rule and should be moved onto the token rather than the token's
   * description being trimmed to match them.
   */
  minTouchTarget: MIN_TOUCH_TARGET,
  /**
   * Chrome along the edges of the frame.
   *
   * A touch target **plus its hairline**, not equal to one. React Native
   * Web sets `box-sizing: border-box` on every `View` and Yoga measures the
   * same way, so a 44 bar with a 1px bottom rule leaves a 43 content box — and
   * a control stretching to fill it is a pixel short of the minimum, or clamps
   * itself back to 44 and hangs that pixel under the bar where the body paints
   * over it. One more pixel here and a control that fills the bar is exactly a
   * touch target, with no number of its own.
   *
   * Derived rather than typed again: an equality asserted in prose beside two
   * independent literals is an equality that quietly stops being true.
   */
  topBarHeight: MIN_TOUCH_TARGET + 1,
  statusBarHeight: 26,
  /**
   * The compact toolbar.
   *
   * 66, measured off Obsidian on iOS: its bar runs from about 865pt to 931pt on
   * a 956pt screen. Well above the 44 a pointer would need, because this is the
   * one strip of the phone layout a thumb has to hit reliably — and the extra
   * height is also what makes `radii.pill` read as a *capsule* rather than as a
   * rounded rectangle, since a full pill's corner radius is half its height.
   *
   * It was 56, which is a rounded rectangle wearing a pill's radius.
   */
  bottomBarHeight: 66,
  /**
   * How much note shows either side of that toolbar.
   *
   * **24, and it was 52 — this is the number the seventh key was bought with.**
   *
   * The 52 was a measurement, not a preference: Obsidian's bar runs from
   * x=52.0 to x=387.7 on a 440pt screen, which is 336pt of pill with 52pt of
   * note showing on each side, and that sliver is most of what makes the bar
   * read as an object lying on the note rather than as an edge with rounded
   * corners. What it was buying is the *sliver*, and a sliver is worth less
   * than a destination.
   *
   * The arithmetic, on a 390pt phone, which is the narrow case rather than the
   * reference's 440 — and **the separator is a term in it**, because the rule
   * `BottomBar` draws before the seventh key is a `flexShrink: 0` child of the
   * row and therefore takes its width off the targets rather than out of thin
   * air:
   *
   *     390 − 2 × 24 = 342          the pill
   *     342 − 2 × 12 = 318          inside `bottomBarPad`
   *     318 −     1  = 317          less `bottomBarRule`, the separator
   *     317 ÷ 7      = 45.29pt      one target — above the 44pt floor
   *
   * and at the old 52:
   *
   *     390 − 2 × 52 = 286
   *     286 − 2 × 12 = 262
   *     262 −     1  = 261
   *     261 ÷ 7      = 37.29pt      under the floor; 261 ÷ 6 = 43.5, also under
   *
   * **That last pt is why the figure is 45.29 and not 45.4.** The divisor was
   * 318, which is the width *before* the rule the same paragraph was
   * describing.
   *
   * **It read 45.4 in nine places across six files, and the commit that
   * corrected it fixed four of them and said "four places".** Two were here and
   * two in the separator's own doc comment — the one that should have caught
   * it. A later pass took the two in `bottomBar.test.ts`, where it had been
   * `318 / 7` compared against `toBeCloseTo(45.43, 2)`, a comment reproduced as
   * an expectation. Three survived until they were swept for good:
   * `ConsoleRail.tsx`, `meetingsEntry.test.ts` and
   * `docs/decisions/meetings.md`. **A count is not a receipt**, and "fixed in
   * four places" is the sentence that tells the next reader not to look — which
   * is why what is recorded here is the shape of the miss rather than a number
   * that sounded complete.
   *
   * The false belief underneath all nine was the same one, and it is the belief
   * that let the row spill: that the separator is free.
   *
   * So a seventh key does not fit at 52 and does at 24, and 24 still leaves a
   * visible sliver of note either side — reduced, not spent. Six of the seven
   * are the note's verbs; the seventh is the app's other place, and
   * `BottomBar`'s trailing separator is what keeps them reading as six and one.
   * `bottomBar.test.ts` computes both rows from these tokens rather than
   * quoting the numbers, so they cannot drift apart from this comment.
   *
   * **It is still the inset that is the measurement, not the width.** An
   * earlier pass sized the bar to its contents and let the inset be whatever
   * was left over, which is right only for the number of actions the reference
   * happens to show: on `@seyi`, where the reader is a team member and there is
   * no New note, five targets left the pill spanning 78→362 — a bar that is
   * supposed to be in the same place on every screen. So the frame insets the
   * slot by this and the bar fills it.
   */
  bottomBarInset: 24,
  /**
   * One target on that toolbar.
   *
   * 52 is what six targets plus `bottomBarPad` either side need to fill the
   * 336pt the reference measures. It is the *natural* width — `bottomBarInset`
   * decides the bar's width and the targets share it — so it stands as the size
   * a target wants when there is room, with `minTouchTarget` underneath it as
   * the floor when there is not. Seven targets on a 390pt phone are under it
   * and land on the floor's side of it at 45.29; see `bottomBarInset`.
   */
  bottomBarTarget: 52,
  /**
   * The toolbar's own horizontal padding, where the width allows it.
   *
   * See `bottomBarTarget` for what it is worth to the look, and
   * `bottomBarGeometry` for the order it is spent in: this is the *first*
   * thing a narrow screen takes back, before the sliver of note either side,
   * because a target is 44pt wide around a 22pt icon and already carries 11pt
   * of its own air at each end of the row.
   */
  bottomBarPad: 12,
  /**
   * The hairline between the note's verbs and the key that leaves the note.
   *
   * A token rather than a `1` in `BottomBar`'s stylesheet because **it is a
   * term in the row's width**, not a decoration painted over it: the rule is a
   * `flexShrink: 0` child of the same flex row as the targets, so every point
   * it takes is a point the seven targets do not divide. Reading it as free is
   * what made this codebase say 45.4 where it is 45.29 — in nine places across
   * six files, of which a commit claiming "four places" fixed four; see
   * `bottomBarInset` for where the other five were and what a count is worth as
   * a receipt. `bottomBarGeometry` subtracts this explicitly now, rather than a
   * comment claiming it is negligible.
   */
  bottomBarRule: 1,
  /**
   * The air a panel leaves between the status bar and its first row.
   *
   * Measured off the reference at 440×956: the sidebar's first row starts at
   * about 92pt, and the status bar's inset on that device is 59 — so 33, of
   * which the tree's own scroller already contributes 8.
   *
   * **A panel does not clear the floating toggle**, which is what it was doing
   * instead: the toggle crossed to the sliver of note the moment a panel came
   * in, so reserving its 44pt here put the first row at 126 with nothing in the
   * space above it.
   *
   * That sentence used to cite `AppFrame`'s `toggleOnSliver` as the reason, and
   * **there is no such symbol** — there is no toggle either. A phone has no
   * left panel and nothing that pulls one in (`features/app/frame.ts`), so the
   * control the citation named went with the panels and took its style with it.
   * What survives is the *measurement*, which never depended on the toggle: 33
   * off the reference, less the 8 the tree's own scroller contributes. The
   * toggle is why the number is not 44 higher, and that is history rather than
   * a live reference.
   */
  panelGutter: 24,
  /**
   * How far the floating chrome sits from the bottom of the glass.
   *
   * 25, measured: Obsidian's bar ends about 25pt above the bottom edge — which
   * is *inside* the 34pt home-indicator inset on a notched phone, and the
   * reference is a notched phone. We do not follow it that far. `AppFrame`
   * takes `max(insets.bottom, this)`, so a device with an inset keeps its
   * inset and a browser window or an un-notched phone — where there is no
   * indicator and nothing to clear — gets the reference's gap instead of the
   * 10pt token that used to serve here and read as "nearly flush".
   */
  floatingGap: 25,
  /**
   * The air above the floating toolbar, between it and the last line of the
   * document.
   *
   * The toolbar is a pill lying on the note rather than a bar ruled off from
   * it, so the frame reserves `bottomBarHeight + floatingInset + floatingGapFor
   * (insets.bottom)` along the bottom edge — this above the pill, and the
   * larger of the home indicator and `floatingGap` below it. That whole sum is
   * `FrameApi.contentInsets.bottom`, and it is spent as **content padding**
   * inside whichever scroller is on screen, so the last line of a long note can
   * be brought out from under the bar rather than being stranded behind it.
   *
   * (This used to say "plus twice this", which stopped being true when the
   * bottom gap became `max(insets.bottom, floatingGap)` — 34 on a notched
   * phone, not 10. The arithmetic is `AppFrame`'s `contentInsets`; this is the
   * one term of it that belongs to the token.)
   */
  floatingInset: 10,
  /**
   * A circular control in the floating chrome.
   *
   * Exactly `minTouchTarget`, and derived from it rather than typed, because
   * this is the one control shape with no room to make up the difference.
   * Elsewhere a small mark sits inside a larger pressable — the bottom bar's
   * icons are 22 inside a 56pt target — so the drawing and the target are
   * separate numbers. Here the visible circle *is* the target: there is no
   * padding around it to grow, and anything below the floor is a control that
   * looks deliberate and misses under a thumb.
   *
   * The first draft of this was 40, with a comment claiming it was above the
   * floor. `appFrameRender.test.ts` caught it, which is the only reason this
   * paragraph is here rather than a 40 in a shipped build.
   */
  chromeButton: MIN_TOUCH_TARGET,
  /**
   * The height of a context pill's visible mark, which is not its target.
   *
   * A phone's only route between contexts is this strip, so the pressable stays
   * `minTouchTarget` — `contextStrip.test.ts` holds that and says what a pill
   * under the floor costs. This is the object drawn inside it: the owner asked
   * for the pills "smaller and squarer" so more workspaces fit at once, and the
   * two numbers are separable precisely because the target is not this one.
   */
  stripPill: 34,
  /**
   * The height of the breadcrumb's own head mark — the `@seyi` at the front
   * of row two, not a `stripPill` copy.
   *
   * The two used to be the identical object: same `stripPill` 34, same
   * `radii.md`, same `shadows.floating`, same `wsSwitch` 13px label. That was
   * right for as long as the pill *was* the switcher, moved down a row —
   * `docs/decisions/app-and-console.md`'s "A context pill's target is not its
   * mark" argues `stripPill` down to 34 and keeps the shadow for exactly that
   * reason, and it was correct about the object it was arguing over. It
   * stopped being the same object when that same file's "The contexts moved
   * into the scroller" put the two rows on different jobs: row one switches
   * *to* a context, row two's head names the one you are already in, and a
   * switcher pill drawn a second time one row down is two objects claiming to
   * be the same control. See that doc's "The breadcrumb head stopped being a
   * switcher pill" for the measurement and the rest of the argument.
   *
   * `stripPill` is untouched — the switcher row still needs the whole target
   * a phone's only route between contexts has always needed. This token is
   * for the one caller that draws a *quieter* mark: `Pill`'s `head` variant.
   */
  crumbPill: 26,
  /**
   * A breadcrumb folder segment's own **drawn** height on a phone — short of
   * the touch floor, exactly the shape `explorerRow` names below.
   *
   * `Breadcrumb.tsx`'s `folder`/`leaf` styles set the `label` role and never
   * touch `lineHeight`, so what actually reaches the screen underneath that
   * font size is still `Text`'s `mono` variant's own line height —
   * `leading(ui, 1.55)`, 20.15pt, at the `ui` size the variant is defined for
   * rather than the `label` size it is drawn at here. Add `segment`'s own 1pt of
   * padding on each edge, for legibility rather than for a thumb, and the row
   * is 22.15: half of 44.
   *
   * This is what somebody **sees**, not what they can press — see
   * `Breadcrumb.tsx`'s folder `PressRow` for why the pressable itself is
   * `minTouchTarget` tall regardless.
   */
  crumbSegmentHeight: leading(13, 1.55) + 1 * 2,
  /**
   * The account mark pinned at the leading end of a phone's top row.
   *
   * 34, and **below `minTouchTarget` on purpose**, which is legal for the same
   * reason `explorerRow` is: what a thumb hits is the pressable around it, and
   * the caller pads to the floor. The mark is one glyph and is recognised
   * rather than read, so it is drawn small and pressed large.
   *
   * **The budget written beside it treated that padding as free, and it is
   * not.** This used to continue: "What 34 buys is the budget for the thing
   * beside it. At 390pt the row is `390 − 2 × 12 gutters = 366`,
   * `366 − 34 avatar − 8 gap − 92 capsule − 8 gap ≈ 232pt for the strip` …
   * A 44pt mark takes ten of those points off the one element on the row that
   * is a *list*." The mark is still 34; what the arithmetic left out is that
   * the pressable around it has to reach the floor, and on a phone that
   * pressable is the product's **only** sign-out control
   * (`ConsoleRail.AccountBlock`). It was padding by 4 — 34 all in, under the
   * floor — so the row was budgeting for a target that missed. The real budget:
   *
   *     390 − 2 × 12 gutters = 366
   *     366 − 44 target − 8 gap − 92 capsule − 8 gap ≈ 214pt for the strip
   *
   * where 92 is the trailing capsule with two targets in it. 214pt still holds
   * the two or three legible names the strip has to show before anybody
   * scrolls, and a control somebody misses is not something ten points buy back.
   */
  accountAvatar: 34,
  /**
   * A row in a grouped list on a phone.
   *
   * Above `minTouchTarget` for the same reason the toolbar is: the floor is
   * what a control must not go below, not what a comfortable list row is.
   *
   * **The file tree is no longer one of these** — see `explorerRow`. A list of
   * settings is a handful of rows a thumb picks one from; a file tree is the
   * only way to reach a note on a phone and is read as a *list*, where the
   * number of rows on screen at once is the thing that decides whether it is
   * usable.
   */
  touchRow: 48,

  /* ---------------------------------------------------------------------- *
   * A file row on a phone, measured off Obsidian on iOS.
   *
   * Taken from a 1320×2868 screenshot (440×956pt at @3x) rather than eyeballed.
   *
   * **This was three numbers and is two.** `explorerIndent` (16, one level of
   * nesting) and `explorerInset` (37, where a top-level name begins) described
   * a *tree*, and the surface they were measured for — a file-tree drawer on a
   * phone — does not exist: a phone has no left panel (`features/app/frame.ts`)
   * and browses through `FolderView`, which lists one folder flat and has no
   * levels to step between. Their only reader was `FileTree`'s `touch` fork and
   * they went with it. The pitch below did not, because a flat listing still
   * has a rhythm and `FolderView` draws it.
   * ---------------------------------------------------------------------- */

  /**
   * The row pitch. **Below `minTouchTarget` on purpose**, which is legal here
   * and nowhere else: the row is drawn at 36 and the pressable carries
   * `explorerRowSlop` of `hitSlop` on each edge, so what a thumb hits is 44.
   * See `PressRow`'s `hitSlop` — pad the pressable, not the visual.
   */
  explorerRow: 36,
  /** `(minTouchTarget - explorerRow) / 2`, derived so the two cannot drift. */
  explorerRowSlop: (MIN_TOUCH_TARGET - 36) / 2,

  /**
   * The note's side margin on a phone, measured off the same reference.
   *
   * One number, used by every band that has to line up with the first
   * character of the document: the editor's own padding, the breadcrumb above
   * it, the notices, and the status line under it. They were 20, 24 and 28
   * before — three guesses at the same measurement, so nothing on the screen
   * shared a left edge with the text it was about, and a breadcrumb four points
   * out from the title under it reads as a mistake even to somebody who could
   * not say what was wrong.
   */
  readingMargin: 25,
} as const;

/**
 * Elevation, as `boxShadow` strings.
 *
 * React Native 0.76+ accepts the CSS shorthand on `View`, and react-native-web
 * has always passed it through, so one string serves both surfaces — which is
 * the only reason these are here rather than as a pair of platform files.
 *
 * There are three because there are three things that float, and they are lit
 * from different places: a toolbar lying on the note casts down, a drawer
 * sliding from the left edge casts sideways, and a sheet rising from the
 * bottom casts up. One shadow reused for all three is what makes a dark
 * interface look flat — every edge glows the same amount and nothing reads as
 * nearer than anything else.
 */
export const darkShadows = {
  /** The bottom toolbar, and the circular buttons in the top corners. */
  floating: "0 6px 20px -6px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.5)",
  /** A drawer or nav sheet coming in from the leading edge. */
  drawer: "24px 0 60px -20px rgba(0,0,0,0.9)",
  /** A sheet rising from the bottom edge. */
  rising: "0 -10px 40px -12px rgba(0,0,0,0.9)",
} as const;

export type Shadows = Readonly<Record<keyof typeof darkShadows, string>>;

/**
 * The same three elevations, lit for a light world.
 *
 * The geometry is identical — same offsets, same blurs, same spread — because
 * the argument for three shadows rather than one is about *where each thing is
 * lit from*, and that does not change with the palette. Only the ink does:
 * a 0.85-alpha black under a white toolbar is a bruise, not a shadow. The
 * colour is a desaturated blue-black rather than pure black so the shade sits
 * in the same hue family as the greys it falls on.
 */
export const lightShadows: Shadows = {
  floating: "0 6px 20px -6px rgba(16,16,28,0.18), 0 1px 3px rgba(16,16,28,0.10)",
  drawer: "24px 0 60px -20px rgba(16,16,28,0.22)",
  rising: "0 -10px 40px -12px rgba(16,16,28,0.20)",
};

/**
 * CSS `clamp(min, preferred, max)` where the preferred term is a viewport
 * percentage. RN has no viewport units, so the caller passes the measured
 * window width.
 */
export function clamp(min: number, vwPercent: number, max: number, width: number): number {
  return Math.min(max, Math.max(min, (width * vwPercent) / 100));
}

/**
 * CSS letter-spacing is in `em`; React Native's is in points. Convert against
 * the size the text is actually rendered at so tracking scales with the type.
 */
export function tracking(fontSize: number, em: number): number {
  return fontSize * em;
}

/**
 * CSS `line-height: 1.55` is a multiplier; RN wants points.
 */
export function leading(fontSize: number, multiple: number): number {
  return Math.round(fontSize * multiple * 100) / 100;
}

/**
 * Where the compact toolbar's edges are, at a given width, for a given row.
 *
 * ## Why this is a function and not two numbers
 *
 * It was two numbers — `bottomBarInset` and `bottomBarPad` — and the
 * arithmetic proving they were enough was done at 390pt and nowhere else. A
 * seventh key was added to the row and the inset was cut 52 → 24 to pay for
 * it, which fits at 390 (45.29pt a target) and at the reference's 440 (52.43),
 * and does not fit anywhere below 381:
 *
 *     375   43.14pt   iPhone SE 2/3, 12/13 mini, 8/7/6s
 *     360   41.00pt   most Android
 *     320   35.29pt   iPhone SE 1st gen, and any window this narrow
 *
 * `minWidth: minTouchTarget` holds each target at 44 rather than letting it
 * shrink — deliberately, because a row of 41pt targets is a bug nobody can see
 * — so what happened instead is that the row **spilled past the pill's rounded
 * edge**: `bar` sets no `overflow` and React Native's default is `visible`.
 * `compact` is every width under 880, so a browser window is in this range too.
 *
 * ## What it spends, and in what order
 *
 * The row cannot be narrower than every target on the floor plus the rules
 * between them, which shrink for nobody. What a narrow screen has to give it is
 * the two margins either side, and they are **not worth the same**:
 *
 *  1. **`bottomBarPad` goes first.** It is air inside the pill, and a 44pt
 *     target already carries 11pt of its own around a 22pt icon, so the row
 *     loses almost nothing visible by giving it up.
 *  2. **`bottomBarInset` goes second, and only once the padding is gone.** It
 *     is the sliver of note showing either side, and that sliver is a
 *     measurement — most of what makes the pill read as an object lying on the
 *     note rather than as an edge with rounded corners. It is spent last
 *     because it is worth the most.
 *
 * A width that never comes near the floor never spends either, so **every
 * device from 381pt up is untouched**: the reference geometry is what it always
 * was, and only the phones that were broken move.
 *
 * ## 320pt, stated plainly
 *
 * Seven targets on the floor plus one rule need 309pt, and there are 320. It
 * fits, at 44.14pt a target, with the padding gone and 5pt of sliver left. The
 * claim that seven keys cannot fit at 320 by any choice of inset holds only
 * while the padding is treated as fixed; it is not, and it is the cheaper half.
 *
 * Under 309 there is no arrangement at all, and the two things left to do —
 * a target under the floor, or a key off the edge — are both bugs. So it
 * answers `fits: false` rather than picking one silently, and `BottomBar`
 * complains where a developer will hear it.
 *
 * ## The inset is the frame's, and this only ever asks for less of it
 *
 * `AppFrame` pads the toolbar's band by `bottomBarInset`, which is why that
 * token is a constant and this returns a number no larger than it. `BottomBar`
 * takes back the difference with a negative margin, so the resting case sets a
 * margin of zero and nothing about the wide layout changes.
 */
export interface BottomBarGeometry {
  /** How much note shows either side of the pill, at this width. */
  inset: number;
  /** The pill's own horizontal padding, at this width. */
  pad: number;
  /** What the targets and the rules divide. `null` until a width is known. */
  inner: number | null;
  /** One target's share of it. `null` until a width is known. */
  target: number | null;
  /** Whether every target lands on or above `minTouchTarget`. */
  fits: boolean;
}

export function bottomBarGeometry(
  width: number,
  targets: number,
  rules = 0,
): BottomBarGeometry {
  const keys = Math.max(0, Math.trunc(targets));
  const rule = Math.max(0, Math.trunc(rules)) * layout.bottomBarRule;

  /*
    A width of 0 is react-native-web before it has measured anything, not a
    screen 0pt wide — the same "absent is not zero" the console applies to
    every other unanswered measurement. Reading it as a screen would collapse
    the pill onto the note for one frame on every launch and then expand it.
  */
  const measured = Number.isFinite(width) && width >= layout.minTouchTarget;
  if (!measured || keys === 0) {
    return {
      inset: layout.bottomBarInset,
      pad: layout.bottomBarPad,
      inner: null,
      target: null,
      fits: true,
    };
  }

  const need = keys * layout.minTouchTarget + rule;
  /*
    What is left for the two margins on each side, floored to a whole point.

    A fraction buys nothing: the sliver and the pill's padding are both design
    numbers rather than measurements to the sub-point, and half a point of note
    showing is not a sliver anybody can see. Flooring spends the odd point on
    the targets, which is the side to err on.

    **It does not avoid a target landing on exactly 44.000, and this comment
    claimed it did.** Landing there is what the arithmetic is *for*: `need` is
    exactly `keys × 44 + rule`, so wherever the odd point divides out evenly the
    inner width is exactly `keys × 44` and every target is exactly the floor.
    Two of the eight widths `bottomRowWidth.test.ts` solves do it — 381, the
    break-even, and 375, an iPhone SE — and so does 309, the width below which
    no arrangement exists at all. That is the intended answer rather than a near
    miss, which is why that file compares against `MIN_TOUCH_TARGET - 1e-9`: the
    tolerance is against binary floating point in the flex solve, not against a
    design that lands on its own boundary.
  */
  const side = Math.max(0, Math.floor((width - need) / 2));

  const inset = Math.min(layout.bottomBarInset, side);
  const pad = Math.min(layout.bottomBarPad, side - inset);
  const inner = width - inset * 2 - pad * 2 - rule;
  const target = inner / keys;

  return { inset, pad, inner, target, fits: target >= layout.minTouchTarget };
}
