import { leading } from "./typography";

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
   * The account button at the foot of the file tree, hairline included.
   *
   * Fixed rather than left to its contents because the tree's activity and
   * agents popovers stand on it: they are anchored a known distance above the
   * column's bottom edge, and a foot that grew by a line would slide under the
   * line that opened them.
   */
  accountFootHeight: 53,
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
 * CSS `clamp(min, preferred, max)` where the preferred term is a viewport
 * percentage. RN has no viewport units, so the caller passes the measured
 * window width.
 */
export function clamp(min: number, vwPercent: number, max: number, width: number): number {
  return Math.min(max, Math.max(min, (width * vwPercent) / 100));
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
