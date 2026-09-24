import { Platform, StyleSheet, type ViewStyle } from "react-native";
import { layout, radii, space } from "../../design/tokens";
import type { Colors, Shadows } from "../../design/theme";

/* -------------------------------------------------------------------------- */

/**
 * WHAT A CLICK IN THE TITLE BAR DOES, WHEN THE BAR IS THE WINDOW'S HANDLE.
 *
 * On the web `-webkit-app-region` means nothing and these are inert; inside
 * the desktop shell the bar is `drag`, so the window moves with the pointer —
 * and a control inside it would move the window instead of activating, which
 * is the one rule `docs/decisions/desktop.md` warned this change would need
 * and the reason it was not smuggled into the change that added the band.
 *
 * **`no-drag` goes on the frame's own slots, never on the controls a route
 * passes into them.** A route can put anything in `switcher`, `tabs`,
 * `topTrailing`, `accountSlot` or `syncSlot`; if the guard lived on those, it
 * would hold for exactly the controls somebody remembered, and the next chip
 * added to the trailing group would drag the window with no diff that looks
 * wrong on its own. On the slot it is structural: whatever is handed in is
 * inside a region that has already opted out.
 *
 * Each slot hugs its content, which is what makes that safe — `topTabs` is
 * `alignSelf: "flex-end"` and only as tall as the tabs hanging from the bar's
 * foot, so the air above them stays the bar's, and draggable. What is left to
 * grab: that air, the gaps between slots, and the run between the chip and
 * the tabs.
 *
 * Asserted through the injected stylesheet in `shellTitleBand.test.ts` —
 * jsdom drops the declaration from the CSSOM, so `getComputedStyle` cannot
 * see it, the same way it cannot see `dvh`.
 */
const DRAG_REGION = { WebkitAppRegion: "drag" } as unknown as ViewStyle;
const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as unknown as ViewStyle;

export const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  frame: {
    backgroundColor: colors.ground,
    overflow: "hidden",
  },

  topBar: {
    height: layout.topBarHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: space.x3,
    paddingHorizontal: space.x3,
    // The title bar is chrome and reads as chrome by being chrome-coloured;
    // the rule under it was the same line doing a value's job.
    backgroundColor: colors.chromeSurface,
  },
  /**
   * The bar as the window's drag handle, applied only when it is also the
   * thing holding the traffic lights. See `DRAG_REGION` for what the slots
   * inside it owe in return, and why they and not their contents carry it.
   *
   * Conditional rather than always-on because it is a claim: a bar that is
   * not reserving the buttons' corner has no business also saying it is the
   * title bar, and on a phone it would make the note's own top chrome
   * un-selectable for a shell that is never there.
   */
  topBarDrag: DRAG_REGION,
  /**
   * The phone's top edge, which is not a bar.
   *
   * No rule, no fill: the chrome is two circular buttons and a chip lying over
   * the same ground the note is on, the way Obsidian mobile draws it. A bar
   * with a hairline under it is a *desktop* toolbar, and on a 390pt screen it
   * spends the top 45pt of the glass saying so.
   *
   * Taller than `topBarHeight`, and derived rather than typed: a row of 44pt
   * circles in a 45pt bar is a bar with half a point of air either side. The
   * hairline that made `topBarHeight` `minTouchTarget + 1` is gone here too,
   * so the pixel it was buying back has nowhere left to hide.
   *
   * **It is one row and there is nothing under it.** The pane below used to add
   * a second strip — a breadcrumb with its own fill and its own rule — so the
   * top 100pt of a 956pt phone was chrome about the note rather than the note.
   * Obsidian spends 50: one transparent row that the document scrolls beneath.
   * `space.x3` of air either side of the circle rather than `space.x4` gets us
   * to the same measure, and the breadcrumb below has been reduced to a single
   * unruled line (`Breadcrumb.barCompact`).
   */
  topBarCompact: {
    /*
      Out of the column and over the document.

      The height and the safe-area padding are applied at the call site, from
      `contentInsets.top`, so the band a scroller pads its content by and the
      band the chrome actually occupies are one number rather than two that
      agree today.

      `zIndex` is set because this is painted *before* the body and has to sit
      above it. React Native's later-sibling rule is what the panels rely on;
      this is the one place that needs the opposite, and paying for it with an
      explicit `zIndex` is cheaper than moving the top bar below the body in the
      tree, where it would also come after the editor in the reading order and
      in the tab order.
    */
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    paddingHorizontal: space.x3,
    gap: space.x2,
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  topLead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    minWidth: 0,
    ...NO_DRAG_REGION,
  },
  /**
   * The tabs' room in the title bar.
   *
   * `flex: 1` so the strip gets the middle of the bar and scrolls inside it
   * rather than pushing the trailing group off the edge; `minWidth: 0` so it
   * really can shrink, which a flex child does not do by default.
   *
   * `alignSelf: "flex-end"` and `alignItems: "flex-end"` are the whole visual
   * idea: the tabs hang from the bar's foot and meet the page, instead of
   * floating in the middle of a row that is centring everything else.
   */
  topTabs: {
    flex: 1,
    minWidth: 0,
    alignSelf: "flex-end",
    alignItems: "flex-end",
    flexDirection: "row",
    ...NO_DRAG_REGION,
  },
  /**
   * The account mark, pinned at the leading end of a phone's top row.
   *
   * `flexShrink: 0` is the pin: it is the first child of a row whose second
   * child is a list, and a flex child that may shrink is one the list squeezes
   * the moment somebody joins a fourth workspace. The strip is what gives way,
   * because the strip is what scrolls.
   */
  accountLead: { flexGrow: 0, flexShrink: 0, ...NO_DRAG_REGION },
  /**
   * The sync pill's box. `flexShrink: 1` and `minWidth: 0` so on a narrow
   * phone it is the pill's words that ellipsise, never the account mark or the
   * capsule's targets.
   */
  syncLead: {
    marginLeft: "auto",
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
    ...NO_DRAG_REGION,
  },
  topTrailAfterSync: { marginLeft: 0, flexShrink: 0 },
  topTrail: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    ...NO_DRAG_REGION,
  },
  /**
   * Obsidian's trailing group: one floating capsule, however many actions.
   *
   * The same surface, radius and shadow as the toggle opposite it, because
   * they are the same kind of object — chrome lying on the note rather than a
   * bar drawn across it. `chromeButton` is the height so the two corners of the
   * screen match; `space.x1` of padding either side because the targets inside
   * are already `chromeButton` wide and the capsule only has to close around
   * them.
   *
   * `gap: 0` on purpose: the actions inside are full touch targets that meet,
   * which is how the reference's book and ⋯ sit — one container, no gutters
   * inside it.
   */
  topTrailCompact: {
    gap: 0,
    minHeight: layout.chromeButton,
    paddingHorizontal: space.x1,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  search: {
    /*
      A control at the trailing edge, not a field across the middle.

      It was a 420pt bordered input centred in the title bar — browser
      furniture, and the widest object in the band, for a feature whose whole
      interface is a keystroke. Centred, it also forced the band into three
      fixed slots, so there was nowhere for tabs to go. As a button beside the
      other actions it costs about 60pt and gives the centre back.

      The label goes with the width: on web the shortcut *is* the label, and a
      magnifier beside it says what it opens. Native keeps a word, having no
      shortcut to show.
    */
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
    /*
      A resting fill, the same one the switcher chip wears.

      It was transparent until hovered, which reads as a word floating in the
      bar rather than a control — and the canvas draws both ends of this bar
      the same way, because a title bar with a filled chip at one end and
      nothing at the other looks unfinished rather than quiet.
    */
    backgroundColor: colors.chipFill,
  },
  searchHover: { backgroundColor: colors.surface3 },
  kbd: { color: colors.chromeMuted },

  /** The three columns. `flex: 1` plus `minHeight: 0` is what makes the
      children scroll instead of the frame growing past the viewport. */
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    position: "relative",
  },

  /*
    No border. The explorer and the page were both `surface` — one value across
    two regions — so a hairline had to be drawn between them to say they were
    different things. They are different values now (`chromeSurface` against
    `pageSurface`), which is what separates panels in this design; the only
    hairlines left in the frame are the seams, and a seam is a 7pt drag target
    that has to be visible to be usable.
  */
  explorerColumn: {
    backgroundColor: colors.chromeSurface,
    position: "relative",
  },

  editor: { flex: 1, minWidth: 0, backgroundColor: colors.pageSurface },

  /**
   * The right panel as a column.
   *
   * `chromeSurface` like the tree, and deliberately: the two are the same kind
   * of thing — chrome either side of the page — and giving this one its own
   * colour would make the console read as three materials rather than two.
   * `borderLeftWidth` where the tree has none, because the tree's edge is
   * drawn by its own resizer and this one's leading edge has to exist even
   * while nothing is being dragged.
   */
  asideColumn: {
    backgroundColor: colors.chromeSurface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.line,
    position: "relative",
  },

  /** Its drag handle, straddling the leading border. See `resizer`. */
  asideResizer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: layout.seamWidth,
    ...(Platform.OS === "web" ? ({ cursor: "col-resize" } as unknown as ViewStyle) : null),
  },
  asideResizerActive: { backgroundColor: colors.accentDim },

  /**
   * The right panel as an overlay, at `medium`.
   *
   * Absolutely positioned and pinned to the trailing edge, so opening it does
   * not reflow the note underneath — the same property the peek has, and for
   * the same reason: a paragraph that jumps sideways when a panel opens is a
   * paragraph somebody loses their place in. Unlike the peek it has a scrim,
   * because it is dismissed by pressing away rather than by moving off a seam.
   */
  asideOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    backgroundColor: colors.chromeSurface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.line,
  },

  resizer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    /*
      Placed from the left, because it is no longer a child of the column it
      belongs to — see the frame's body. `left` is the column's own width less
      the overhang, so the strip straddles the border it is drawn on rather
      than sitting beside it: `explorerSeamOverhang` of it lies over the
      editor and the rest over the tree.
    */
    width: layout.seamWidth,
    // RN's `CursorValue` is `"auto" | "pointer"` only; every other CSS cursor
    // needs the same escape hatch `css.ts` uses for gradients and masks.
    ...(Platform.OS === "web" ? ({ cursor: "col-resize" } as unknown as ViewStyle) : null),
  },
  resizerActive: { backgroundColor: colors.accentDim },
  /** Past the floor: releasing here folds the column away rather than snapping back. */
  resizerArming: { backgroundColor: colors.warnWash },
  /** The bar drawn inside an arming seam, so the state is visible and not only felt. */
  seamArmMark: {
    position: "absolute",
    top: "50%",
    left: 1,
    width: 5,
    height: layout.seamPillHeight,
    marginTop: -layout.seamPillHeight / 2,
    borderRadius: radii.xs,
    backgroundColor: colors.warn,
  },

  /**
   * The seam between two panels.
   *
   * A hairline the layout needed anyway, drawn as a border rather than a fill so
   * that at rest it is exactly the rule it replaced — the control costs nothing
   * on the screen until a pointer goes looking for it.
   */
  seam: {
    width: layout.seamWidth,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as unknown as ViewStyle) : null),
  },
  seamHot: { borderRightColor: colors.accent },

  /**
   * The seam left where a folded panel was: wider, and lit.
   *
   * Wider because it is the only thing standing where a whole column stood, and
   * because it is a control rather than a rule — 7pt is a comfortable target
   * beside something; 10pt is a comfortable target beside nothing.
   */
  seamClosed: {
    width: layout.seamClosedWidth,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    /*
      `surface3`, not `surface2`, and the difference is the whole point of the
      strip. On the light palette `surface2` is #FAFAFA against a #FFFFFF
      ground — a browser check showed it reading as nothing at all, so the only
      thing saying a panel could come back was a hairline indistinguishable
      from the rule between two columns. A recessed strip says "there is
      something here" before anybody hovers it.
    */
    backgroundColor: colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as unknown as ViewStyle) : null),
  },
  seamClosedActive: { backgroundColor: colors.accentDim, borderRightColor: colors.accent },

  seamPill: {
    width: layout.seamPillWidth,
    height: layout.seamPillHeight,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
    /*
      Drawn and invisible rather than absent, so that revealing it is a fade
      rather than a node appearing under the pointer that caused it — and so the
      seam's own width never changes, which would move the editor.
    */
    opacity: 0,
    boxShadow: shadows.floating,
  },
  seamPillShown: { opacity: 1 },

  /**
   * The peek: the folded tree, over the editor rather than beside it.
   *
   * Absolute, so nothing reflows when it arrives — see the branch that renders
   * it. `left` and `width` are supplied there; everything that is a constant is
   * here.
   */
  explorerPeek: {
    position: "absolute",
    top: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    zIndex: 2,
    boxShadow: shadows.floating,
  },

  /** The warm strip down the leading edge in focus mode. Draws nothing itself. */
  focusEdge: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: layout.focusEdgeWidth,
    zIndex: 3,
  },
  focusExit: {
    position: "absolute",
    top: space.x4,
    left: space.x3,
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  /**
   * A panel toggle in the status bar: a two-cell picture of the layout.
   *
   * The panel, then the document. Filled when the panel is out, a thin bar when
   * the rail is down to its icons, empty when it is folded away — so the glyph
   * is the layout rather than a label for it, which is what fits in 26pt.
   */
  panelToggle: {
    height: layout.statusBarHeight - 8,
    paddingHorizontal: space.x2,
    borderRadius: radii.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTogglePressed: { backgroundColor: colors.surface3 },
  toggleGlyph: { flexDirection: "row", alignItems: "center", gap: 1 },
  toggleCell: {
    width: 4,
    height: 11,
    borderRadius: 1,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  toggleCellOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleDoc: { width: 8, height: 11, borderRadius: 1, backgroundColor: colors.line },
  /** The room the status node spreads into. `minWidth: 0` so a long path clips. */
  statusFill: { flex: 1, minWidth: 0 },

  statusDivider: {
    width: 1,
    height: 12,
    marginHorizontal: space.x2,
    backgroundColor: colors.line,
  },

  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.scrim,
  },
  /**
   * The rail as a panel: the tree drawer's geometry, 40pt narrower (300 against
   * 340) because a list of destinations needs less width than a file tree with
   * two levels of indent. The same gesture from the same edge, but its own
   * style — the two are allowed to diverge, and sharing one would make that a
   * rename rather than an edit.
   */
  navSheet: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "86%",
    maxWidth: 300,
    borderRightWidth: 1,
    borderRightColor: colors.lineStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.drawer,
  },
  /*
    `navToggle`, `navToggleCompact` and `navTogglePressed` were here, and are
    gone. They dressed the control that pulled the rail in: a stretched 44pt
    target on a pointer layout, and on a phone a shadowed white capsule around
    the context chip. `frame.ts` answers `navToggle: false` at every density
    now — a phone's navigation is the context strip and the seventh key, and a
    pointer layout has the rail as a permanent column — so all three had zero
    render call sites.

    They are a deletion rather than a survivor, which is the distinction
    `frame.ts`'s "what is deliberately kept" list exists to make: the `sheet`
    and `drawer` arms of `Regions` are kept because callers outside this feature
    hold the API that raises them, and a *drawing* of a control no density asks
    for is held by nobody. `Explorer`'s `touch` fork went the same way.

    They outlived their control because prose kept describing them:
    `console/_layout.tsx` explained that it dropped the switcher chip's own
    border because `navToggleCompact` "already draws a shadowed white capsule
    around it". Nothing drew one, and the style it named was unreachable — which
    also made the `switcherCompact` it was justifying unreachable, since a phone
    renders no switcher at all.
  */
  drawer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    // Never the whole screen: the sliver of editor still showing is what says
    // "this is a panel over your note", and it is a second way to dismiss it.
    //
    // 372 rather than 340, measured: Obsidian's covers to about 368pt of a
    // 440pt screen. The cap is what binds on a large phone — 86% of 440 is 378
    // — and the percentage is what binds on a small one, where a fixed 372
    // would leave no sliver at all.
    width: "86%",
    maxWidth: 372,
    borderRightWidth: 1,
    borderRightColor: colors.lineStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.drawer,
  },
  /**
   * A panel on a phone is an object, not a column.
   *
   * Rounded on its trailing edge and unruled: the hairline is what a *column*
   * beside a document needs, and a panel that has been slid over one already
   * has a shadow and a scrim saying the same thing twice as loudly. Applied to
   * both panels from one place because they are the same object in two sizes,
   * and the two stylesheets above have already drifted once.
   */
  panelRounded: {
    borderRightWidth: 0,
    borderTopRightRadius: radii.floating,
    borderBottomRightRadius: radii.floating,
  },

  status: {
    height: layout.statusBarHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.x4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface2,
  },

  /**
   * The slot the toolbar lives in, which draws nothing.
   *
   * It used to be the toolbar's own background and top rule. The toolbar is a
   * floating pill now and carries its own surface and shadow, so a fill here
   * would be a second bar behind it, and a rule would be the edge the pill
   * exists not to have. What is left is the *reservation*: the frame keeps
   * this much of the bottom edge for the toolbar rather than letting the
   * document run under it. See `layout.floatingInset` for why reserved and not
   * overlaid.
   */
  bottomBar: {
    /*
      Over the document rather than beside it.

      This slot used to be the last child of a column, so the body ended where
      the toolbar began: a hard edge across the glass with the note stopping
      short of it. The reference has the note running *behind* the pill — body
      text is visible to the left and the right of it on the lines it covers —
      which is only possible if the scroller is full height and pays for the bar
      in content padding instead. `contentInsets.bottom` is that payment.
    */
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },

  iconButton: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonRound: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },
  /** See `grouped`: the target, without the surface its container already has. */
  iconButtonGrouped: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
  },
  iconButtonHover: { backgroundColor: colors.surface3 },
  iconButtonPressed: { backgroundColor: colors.chromePressed },
});

/** What every piece of the frame reads its styles from — one factory, so one themed cache entry. */
export type FrameStyles = ReturnType<typeof makeStyles>;
