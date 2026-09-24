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
