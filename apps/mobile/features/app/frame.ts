/**
 * Which regions of the console are on screen, at what width.
 *
 * The console is one application with three regions — explorer, editor,
 * status — and the whole of the responsive design is deciding which of them
 * exist at a given width and which one owns the screen. That decision is here,
 * as a pure function, rather than as a pile of `width < 880 &&` scattered
 * through the components: there are three densities and three regions, and the
 * combinations that are wrong (an explorer drawer *and* an explorer column, a
 * bottom bar on a desktop) are exactly the ones
 * nobody notices until somebody rotates a tablet.
 *
 * ## Neither surface is the other one degraded
 *
 * This app ships to a browser and to a phone from one codebase, and both are
 * the product. A pointer and a touchscreen are genuinely different machines:
 * one has a right button, a keyboard and 1400px of width; the other has a
 * thumb, a soft keyboard and 390px. Designing for either one and deriving the
 * other produces a recognisable failure in both directions — a desktop layout
 * shrunk down gives you 20px tap targets and a tree you cannot hit, and a phone
 * layout stretched out gives you a 1400px column of chrome with nothing in it.
 *
 * So each density is designed on its own terms. `wide` is a real desktop
 * application: a resizable explorer beside the note, a status bar, and every
 * operation on a keyboard chord. `compact` is a real phone application: the
 * editor owns the screen and the verbs sit on a bottom toolbar within thumb
 * reach, the way Obsidian mobile does it. `medium` is the honest middle — a
 * tablet has room for the explorer column beside the note and for nothing
 * else, and it says so.
 *
 * What they share is this function and the models underneath it, which is the
 * point: the *rules* are one implementation, so a refusal or a permission
 * cannot exist on one surface and go missing on the other. Only the
 * presentation forks.
 *
 * Deciding it from a number also makes it testable. This repo's suite runs in
 * plain node with no renderer, so a layout decided by a width is a layout with
 * tests, and the combinations that are wrong fail in CI rather than on a device
 * somebody happens to pick up.
 *
 * ## Why every presentation of the tree is the same region
 *
 * `explorer: "column" | "drawer" | "peek" | "hidden"` is one field on purpose.
 * The file tree has one selection, one expansion set and one scroll position no
 * matter how it is presented, and modelling a second presentation as a separate
 * thing is how you end up with a tablet that opens the drawer, rotates, and
 * shows you a column scrolled somewhere else.
 *
 * ## The panels fold away, and the seam between them is the control
 *
 * On a pointer layout both left panels can be put away, which is what
 * `explorerHidden`, `explorerPeeking` and `focus` on `FrameState` are for. The
 * rules are all here; the drawing is `AppFrame`'s.
 *
 *  - **`explorerHidden`** folds the column away entirely. `explorerToggleFor`
 *    used to be a constant `null` above a comment reserving this exact change;
 *    it is taken now, and the comment there says so rather than being deleted.
 *  - **`explorerPeeking`** brings the folded tree back *over* the editor while
 *    the pointer rests on its closed seam — which is what makes folding it a
 *    cheap decision rather than a commitment, and which is why `peek` is an arm
 *    of `explorer` and not a `drawer` with the scrim suppressed. See
 *    `Regions.explorer`.
 *  - **`focus`** folds both for the length of a read, and keeps the status bar,
 *    which is the way back out.
 *
 * The first three are **preferences and a mode** in the sense this file already
 * uses: `explorerHidden` survives a resize because it is a choice about how you
 * like the app, while `explorerPeeking` and `focus` are cleared by
 * `panelsClearedFor` because they are claims about what is on the screen right
 * now. Getting that split wrong in either direction is the failure mode: a
 * cleared preference is a resize that rewrites what somebody chose, and an
 * uncleared mode is a rotation that returns you to a stripped app.
 *
 * ## There is no rail, at any density
 *
 * **`Regions` has no `rail` field, and `FrameState` has no `navOpen` or
 * `railCollapsed`.** They are gone rather than kept, because the list two
 * sections down is about arms with callers outside this feature and the rail
 * had none left: the contexts, the app-level panes, a claim, a new workspace,
 * Meetings and sign-out are all in `features/console/SwitcherMenu.tsx`, under
 * the name already in the title bar. A 216pt column of them beside a 260pt
 * file tree beside the note made three columns where the design draws two.
 *
 * This reverses nothing about a phone. A phone has
 * **no left panel at all** — no file-tree drawer, no toggle for it and no scrim
 * from it — because navigation moved to two surfaces
 * that are always on the glass and are not panels: a horizontally scrolling
 * **context strip** (`features/console/NavBand.tsx`, at the top of the
 * scroller, above the path) and a seventh key on the bottom row. Neither has to
 * be summoned, so neither can be missing; a person is never one press away from
 * navigation, they are looking at it.
 *
 * **The strip was a slot in this frame's top bar and is not any more**, which
 * changes where it is drawn and nothing about the invariant: a floating bar
 * means the document runs behind whatever is in it, which the note's own verbs
 * earn and navigation does not. It is in the scroller now, so it scrolls away
 * with the document. What is left pinned in the top row is the `accountSlot`
 * and the trailing capsule.
 *
 * The old invariant — "every compact layout offers a panel toggle" — is
 * therefore retired rather than dropped, and
 * `appFrame.test.ts` carries the rule that replaced it: at compact there is
 * always a context strip and always a bottom row. A toggle for a panel that
 * does not exist is not navigation, which is what made the old assertion the
 * right one to write and the wrong one to keep.
 *
 * ## What is deliberately kept although no density reaches it
 *
 * This is the whole list. **Anything not on it that a phone used to reach is a
 * deletion, not a survivor** — that is what makes the list worth keeping, and
 * it is enforced by being read: the day something else here stops being
 * reachable it is added with its reason or it goes.
 *
 *  - **The `drawer` arm of `Regions.explorer`, the `scrim`, and `drawerOpen`
 *    on `FrameState`.** `AppFrame`'s API (`closeDrawer`, `closeOverlays`,
 *    `closesOnSelect`) is consumed outside this feature — the file tree and the
 *    console layout both hold it — and retiring the representation is one
 *    change, made where those callers are, rather than a hole opened here for
 *    somebody else to find.
 *  - **The two branches in `AppFrame` that draw them**, and the styles those
 *    branches use. This is the same entry seen one layer down rather than a
 *    second decision: a representable region with nothing that can draw it is
 *    precisely the hole the line above refuses to open, so the arms and their
 *    drawings go together or not at all. `appFrameRender.test.ts` asserts that
 *    neither renders at any density, which is what stops "kept" from quietly
 *    becoming "reachable again".
 *
 *    **The rail's arms and its sheet went that way rather than onto this
 *    list**, in one change: `Regions.rail`, `Regions.navToggle`,
 *    `FrameState.navOpen`, `FrameState.railCollapsed`, `railToggleFor`,
 *    `AppFrame`'s `rail` slot and `closeNav`, the column, the seam, the sheet
 *    and `ConsoleRail` itself. Sign-out is on the account mark pinned to the
 *    phone's top row, and in `SwitcherMenu` on a pointer layout.
 *  - **`menu.ts`'s `platform: "touch"` arm**, which decides that a surface with
 *    no keyboard prints no chords and is offered no "Open in new tab". That is
 *    a *rule* rather than a rendering fork, `menu.ts` is its single owner, and
 *    both values are checked; deleting it would move the decision into whatever
 *    grows a long-press menu next. `Explorer` no longer derives it from the
 *    density — it passes the literal `"web"`, because it is a pointer-layout
 *    region and nothing else.
 *
 * **What was removed rather than kept**, so that the two lists are visibly
 * different things: `Explorer`'s whole `const touch = frame.density ===
 * "compact"` fork — a footer icon row, a revealed filter, an autofocus, a
 * "Close the file tree" button, thumb-sized targets — and `FileTree`'s `touch`
 * presentation with it. Those are *drawings* of a region that is `hidden` at
 * compact, with one caller each inside this feature, so nothing outside was
 * holding them and nothing was deciding anything by them.
 */

import { layout } from "../design/tokens";

/**
 * How much room there is, in three named steps.
 *
 *  - `compact` — a phone, or a narrow window. One region owns the screen and
 *    the bottom bar carries the verbs.
 *  - `medium` — a tablet, a split-screen laptop window. The explorer earns a
 *    permanent column beside the editor.
 *  - `wide` — a real desktop window. Everything is visible at once.
 */
export type Density = "compact" | "medium" | "wide";

export function densityFor(width: number): Density {
  if (width < layout.narrowBreakpoint) return "compact";
  if (width < layout.wideBreakpoint) return "medium";
  return "wide";
}

/**
 * What the person has toggled.
 *
 * Deliberately *preferences*, not answers: `drawerOpen` is meaningless at
 * `wide` and `explorerHidden` is meaningless at `compact`, and neither is
 * cleared when the window resizes. Somebody who folds the tree away, narrows
 * the window and widens it again gets their folded tree back — clearing the
 * preference on every resize is the behaviour that feels broken.
 */
export interface FrameState {
  /** Compact only: the explorer drawer is pulled in over the editor. */
  drawerOpen: boolean;
  /** Medium and wide: the explorer column's width, in points. */
  explorerWidth: number;
  /**
   * Medium and wide: the explorer column is folded away entirely.
   *
   * A **preference**, and a second field beside `explorerWidth` rather than a
   * width of zero. One number meaning both would make a 40pt tree
   * representable — which is exactly what `clampExplorerWidth`'s floor exists
   * to refuse — and re-opening would have to invent a width instead of
   * restoring the one somebody dragged to.
   */
  explorerHidden: boolean;
  /**
   * Medium and wide: the folded tree is peeking over the editor.
   *
   * A **mode**, not a preference: it is pointer hover state, so it is either
   * true of what is under the pointer right now or it is stale. Read only
   * while `explorerHidden` — a peek beside an open column would be two trees
   * on one screen.
   */
  explorerPeeking: boolean;
  /**
   * Medium and wide: both panels are folded away for the length of a read.
   *
   * One boolean *over* the two preferences rather than a snapshot *of* them,
   * which is what makes leaving it free: `explorerHidden` and `explorerWidth`
   * are untouched while this is set, so clearing it restores exactly what was
   * there with no second copy of the state to keep in step.
   */
  focus: boolean;
}

export const initialFrame: FrameState = {
  drawerOpen: false,
  explorerWidth: layout.explorerWidth,
  explorerHidden: false,
  explorerPeeking: false,
  focus: false,
};

export interface Regions {
  /**
   * `column` sits beside the editor; `drawer` slides over it behind a scrim;
   * `peek` slides over it without one.
   *
   * ## Why `peek` is its own arm and not `drawer` with a flag
   *
   * The invariant below — and `appFrame.test.ts` — promises the scrim exists
   * *if and only if* a panel is over the editor, and asserts it by naming
   * `drawer`. The peek is over the editor and must **not** have a
   * scrim: it is dismissed by moving the pointer away, and a scrim would grey
   * out and make inert the note somebody is peeking in order to reach.
   *
   * The alternative was to keep one `drawer` arm and loosen the invariant's
   * word to "modal". This costs one more arm in a union that is already this
   * file's subject, and keeps a proven assertion literally true instead of
   * weakening the word it rests on. Recorded in
   * `docs/decisions/app-and-console.md`.
   */
  explorer: "column" | "drawer" | "peek" | "hidden";
  /** The editor is always rendered — there is no density with nothing to read. */
  editor: true;
  /** The scrim that dismisses whichever panel is over the editor. */
  scrim: boolean;
  /** Thumb-reach verbs. Compact only; a pointer has the menu and the keyboard. */
  bottomBar: boolean;
  /** Counts, save state and the conflict-check mode. No room for it on a phone. */
  statusBar: boolean;
  /**
   * The button that pulls the drawer in. **False at every density.**
   *
   * A phone has no file-tree drawer to pull in — see the file header — and a
   * pointer layout has the column already. It is kept as a field rather than
   * deleted because `drawer` is still a representable value of `explorer`, and
   * a region with no control to raise it is the pair this file exists to keep
   * honest.
   */
  drawerToggle: boolean;
}

/**
 * The whole responsive design, as a function.
 *
 * Three invariants hold for every input, and each is asserted in the tests
 * because each is one careless edit away:
 *
 *  - nothing is ever a permanent region and a panel over the editor at once,
 *    and the scrim exists if and only if some panel is over the editor;
 *  - the bottom bar and the status bar are **never** both present. They are two
 *    answers to "what goes along the bottom edge", and a screen with both has
 *    28px of chrome saying nothing and a toolbar the thumb cannot reach.
 */
export function regionsFor(
  density: Density,
  state: FrameState,
  /**
   * Whether this route has a file tree at all.
   *
   * Browse does; Map and Connections do not — they are app-level panes that
   * span every context, and there is no single tree that belongs beside them.
   * Without this, a wide window would draw a 260px empty column next to the
   * constellation and a phone would offer a drawer button that pulls in
   * nothing, which is worse than either pane simply being full width.
   */
  options: { hasExplorer?: boolean } = {},
): Regions {
  const hasExplorer = options.hasExplorer ?? true;

  if (density === "compact") {
    /*
      A phone has no left panel. Not a hidden one, not one behind a toggle —
      none, at either route, whether or not there is a file tree.

      The tree used to come in over the editor under a scrim, and `drawerOpen`
      decided whether it was up. That flag is still on `FrameState` and is not
      read here, which is the whole of the change: navigation moved onto the
      glass, to the context strip along the top and the seventh key on the
      bottom row, and a panel that has to be summoned is not what a phone
      offers any more. See the file header for what that retires and why the
      reason it retires is not the reason the drawer was added.
    */
    return {
      explorer: "hidden",
      editor: true,
      scrim: false,
      bottomBar: true,
      statusBar: false,
      drawerToggle: false,
    };
  }

  /*
    Focus mode: the panels go, the instruments stay.

    Answered before anything else because it overrides both preferences without
    writing to it — see `FrameState.focus`. The status bar deliberately
    survives: it carries the save state, the conflict-check mode and the tree's
    own toggle, so it is the way back out, and a mode that hides its own escape
    hatch is one people enter exactly once. Removing the *panel* is the point;
    removing the *instruments* is a different feature nobody asked for.
  */
  if (state.focus) {
    return {
      explorer: "hidden",
      editor: true,
      scrim: false,
      bottomBar: false,
      statusBar: true,
      drawerToggle: false,
    };
  }

  /*
    `explorerPeeking` is read on the closed branch and nowhere else, which is
    what makes "a peek and a column at once" unrepresentable rather than merely
    untested: a stale peek flag beside an open column draws a column.
  */
  const explorer: Regions["explorer"] = !hasExplorer
    ? "hidden"
    : !state.explorerHidden
      ? "column"
      : state.explorerPeeking
        ? "peek"
        : "hidden";

  return {
    /*
      **No rail at any pointer density**, which is why this branch no longer
      weighs one against the explorer column.

      It was a 216pt column of workspaces and offers beside a 260pt file tree
      beside the note — three columns, where the design draws two. Five
      workspaces and four offers do not earn a permanent column; they earn a
      menu under the name already in the title bar, which is where you look to
      know whose notes are open. `SwitcherMenu` is that menu and carries
      `railGroup`'s list unchanged.

      This reverses "The contexts moved into the scroller" (§1007) **for
      pointer densities only** — that decision is about a phone, where a strip
      of pills lay across somebody's note at every scroll position, and
      `compact` still answers `hidden` here for its own reasons, untouched. It
      moves "The rail is one list, with the personal workspace pinned to the
      top" (§1464) without changing it: same `railGroup`, same pin, same
      marker, different container. Both are recorded in
      `docs/decisions/app-and-console.md`.

      `railCollapsed` and `navOpen` are gone from `FrameState` rather than
      kept unread. Stored frame state is read field by field, so a persisted
      copy carrying either one is ignored and needs no migration — and a field
      nobody asks for is a field the next reader has to work out the fate of.
    */
    explorer,
    editor: true,
    // The peek is the one panel over the editor that raises no scrim; see
    // `Regions.explorer` for why that is an arm of its own and not a flag.
    scrim: false,
    bottomBar: false,
    statusBar: true,
    drawerToggle: false,
  };
}

/**
 * What stands at the leading end of the top bar.
 *
 * `"switcher"` is `SwitcherMenu` — the open workspace's name, and behind it
 * every other workspace, Meetings, a claim, a new workspace, Settings and
 * sign-out. `"account"` is the signed-in mark, pinned alone in the corner.
 *
 * One fork, in the file that owns where things live, because two callers read
 * it and they must not drift: `AppFrame` draws the bar, and
 * `reachability.ts` decides at which densities a door claimed on the switcher
 * is allowed to be claimed. That guard used to read `Regions.rail` — the rail
 * *was* the pointer layout's navigation — and when the rail folded into the
 * switcher there was no field left to read, which is the moment a guard
 * quietly starts agreeing with everything.
 *
 * A phone gets the account mark rather than the switcher because its
 * navigation is the band inside the scroller (`features/console/NavBand.tsx`)
 * and a second switcher in the bar would be the same list twice on a 390pt
 * screen. What the corner has instead is the product's only sign-out, which
 * cannot scroll away.
 */
export function topBarLeadFor(density: Density): "switcher" | "account" {
  return density === "compact" ? "account" : "switcher";
}

/**
 * The explorer column's width, held between a floor and a ceiling.
 *
 * The floor is where a kebab-case note name under two levels of indent stops
 * being readable; the ceiling is where the editor's measure drops below the
 * ~65 characters that make prose comfortable. Dragging is allowed to feel free
 * within that, and refuses outside it rather than letting somebody hide a
 * region by dragging it to zero and then wondering where it went.
 */
export function clampExplorerWidth(width: number): number {
  if (!Number.isFinite(width)) return layout.explorerWidth;
  return Math.min(layout.explorerMaxWidth, Math.max(layout.explorerMinWidth, Math.round(width)));
}

/**
 * What toggling the explorer means at this density.
 *
 * One command (`toggleExplorer`, ⌘B on web, the pill on the tree's seam)
 * resolved here so neither the keymap nor the button has to know the density.
 * Returning the *field to change* rather than mutating keeps this callable
 * from a reducer.
 *
 * This is the single owner of that meaning, and `AppFrame.toggleExplorer` is
 * its only caller: for a while the frame implemented a different rule of its
 * own, this function was imported by nothing but its own test, and its chord
 * toggled the *rail* on any layout with an explorer column — a duplicate of
 * ⌘B that never touched the region it is named after. ⌘B is this command's own
 * chord now: the rail folded into the switcher, so there is one left panel and
 * one chord for it.
 *
 * **It answers `"explorerHidden"` at medium and wide now, and that reverses
 * what this comment used to say.** It used to be a constant `null`, because
 * "medium and wide have a permanent explorer column: there is no drawer to
 * pull in, and hiding the column outright is a product decision nobody has
 * taken. The day somebody takes it, this is where it lands — one function, one
 * meaning, and every caller follows." It landed, and it landed here.
 *
 * Two arms still answer `null`, and neither is a leftover:
 *
 *  - **`compact`**, which has no left panel at all (see the file header). Not
 *    "the decision has not been taken there" — there is no panel for it to be
 *    about.
 *  - **A route with no file tree**, which is Map and Connections. Writing
 *    `explorerHidden` there would set a preference on a pane that cannot show
 *    it, and you would discover it later as a missing tree back on Browse.
 *    That is the same shape as the bug this function was extracted to end,
 *    where `"drawerOpen"` was answered on a pane whose `regionsFor` discarded
 *    it and the keystroke looked inert while writing state. It is also why the
 *    flag stays on the signature: it was kept unread for exactly this.
 */
export function explorerToggleFor(
  density: Density,
  options: { hasExplorer?: boolean } = {},
): "explorerHidden" | null {
  if (density === "compact") return null;
  return (options.hasExplorer ?? true) ? "explorerHidden" : null;
}

/**
 * Whether ⌘\ has anything to fold at this density.
 *
 * A boolean rather than a field name, because unlike `explorerToggleFor` focus
 * has exactly one field and no per-density meaning — what varies is only
 * whether there is anything on the screen for it to act on.
 *
 * `false` at compact for `explorerToggleFor`'s reason rather than a new one: a
 * phone has no left panel, so there is nothing to fold away, and a chord that
 * wrote `focus` there would be setting a mode no compact layout reads — which
 * is precisely the ⌘B failure (`railCollapsed` written on a surface that never
 * looked at it) that this pair of functions exists to keep from happening
 * again. That failure outlived the field: ⌘B, `railCollapsed` and the rail are
 * all gone, and the shape of the mistake is what is being guarded here.
 */
export function focusToggleFor(density: Density): boolean {
  return density !== "compact";
}

/**
 * The panels, put away when the layout stops having anywhere to put them.
 *
 * `FrameState` above argues that a resize must not rewrite what somebody
 * chose, and that argument is right — about `explorerHidden` and
 * `explorerWidth`, which are *preferences*. `drawerOpen` is not a preference.
 * It is "a panel is currently over your editor", which is a thing that is
 * either true of what is on the screen or is stale.
 *
 * Left uncleared they are write-once-and-stuck: there is no drawer, no scrim
 * and no toggle at any density now, so nothing can put them away and they wait.
 * That used to be a description of medium and wide only, and the case it was
 * written for was real — open the tree on an iPad in portrait (820pt is under
 * `narrowBreakpoint`, so compact), rotate to landscape, work in the explorer
 * column, rotate back, and a drawer nobody asked for is sitting over the note
 * behind a full-body scrim.
 *
 * **The compact exemption is gone with the panels.** It existed because compact
 * was the one density that *had* somewhere to put them; it does not, so a flag
 * left over from a bundle that did is cleared here rather than left to be read
 * by a `regionsFor` that no longer looks at it. The density is still taken —
 * this is the one place that decides where a panel may live, and a density that
 * grows one back changes this line and nothing else.
 *
 * Returns the same object when there is nothing to clear, so this is safe to
 * call from a state updater on every density change.
 */
export function panelsClearedFor(_density: Density, state: FrameState): FrameState {
  if (!state.drawerOpen && !state.explorerPeeking && !state.focus) return state;
  return { ...state, drawerOpen: false, explorerPeeking: false, focus: false };
}

/**
 * The gap the floating chrome keeps from the bottom of the glass.
 *
 * `max`, never a sum: on a notched phone the home indicator's inset is already
 * a gap, and adding a float on top of it is a bar hovering 68pt above the
 * indicator. `layout.floatingGap` is the floor, measured off Obsidian, so a
 * browser window or an un-notched phone gets the reference's 25pt rather than
 * reading as flush against the edge.
 *
 * One function because there are two callers and they must not drift: the
 * frame reserves this much below its bottom slot, and the keyboard accessory
 * bar spends the same amount so that it lands exactly where the toolbar it
 * covers was.
 */
export function floatingGapFor(safeAreaBottom: number): number {
  return Math.max(safeAreaBottom, layout.floatingGap);
}

/** How much room a surface has to leave at its top and bottom edges. */
export interface EdgePadding {
  top: number;
  bottom: number;
}

/**
 * The height of *our own* chrome lying over a surface, at each edge.
 *
 * Kept apart from the system's insets and added to them, because they are two
 * different claims on the same band. A screen's own floating header adds to the
 * notch; it does not replace it.
 */
export interface ChromeHeights {
  top?: number;
  bottom?: number;
}

/**
 * What a surface owes at each edge, **split by how it has to be paid**.
 *
 * The split is the whole point, and it exists because a scroller has two
 * different top edges. Padding put on the *content* scrolls away with the
 * content: it decides where the first line rests, and nothing more. Padding put
 * on the view *around* the scroller shortens the viewport, and that is the only
 * kind that is still there once somebody has swiped.
 *
 * So a number that must hold while scrolling cannot be spent on the content, and
 * a number that must let its line be brought out from under something cannot be
 * spent on the viewport. There is one of each.
 */
export interface SurfacePadding {
  /**
   * Paid **outside** the scroller, where it shortens the viewport.
   *
   * The system's furniture at the top of the glass — the status bar and the
   * Dynamic Island. Content may not be laid out under it at rest *and may not
   * scroll under it either*: an opaque clock over body text is illegible
   * whatever put it there, and the platform draws that clock over whatever we
   * leave beneath it.
   */
  viewport: EdgePadding;
  /**
   * Paid as **content padding**, where it scrolls.
   *
   * Our own floating chrome — the round toggle, the trailing capsule, the
   * bottom pill — plus the home indicator's own gap at the foot. Content is
   * *meant* to run under these: that is how Obsidian draws them, and the
   * giveaway in the reference is body text visible either side of the floating
   * pill on the lines it covers. What the padding buys is that the first and
   * last lines can still be brought out from under them, which a shortened
   * viewport can never do.
   */
  content: EdgePadding;
  /** The two together: what a surface that does not scroll pays as plain padding. */
  top: number;
  bottom: number;
}

/**
 * **The one place this arithmetic happens.**
 *
 * A surface pays for two things at each edge, only one of them is ours, and —
 * see `SurfacePadding` — they are not paid in the same place:
 *
 * - The **system's** top furniture shortens the surface. This is the half that
 *   was wrong: it used to go on the content container with everything else, so
 *   every screen was correct at rest and drew its text across the clock the
 *   moment anybody scrolled. A guard that only checked the resting layout could
 *   not see it, which is why `safeArea.test.ts` now scrolls.
 * - **Our** floating chrome is content padding, and stays content padding.
 *
 * `framed` is what stops either half being paid twice. Inside `AppFrame`,
 * `FrameApi.contentInsets` already *is* "the system's insets plus the frame's
 * own chrome, at whichever density you are at", and `FrameApi.viewportInsets`
 * names the part of that sum which has to be spent outside the scroller — the
 * frame is the only thing that knows whether it padded itself down past the
 * notch (a pointer layout, where the answer is nothing: the frame's own
 * `paddingTop` already shortened every scroller inside it) or floated its bars
 * over a full-bleed document (a phone). Outside the frame — `/login`,
 * `/authorize`, `/welcome`, the invitation and share screens, the landing page
 * — there is no such answer, and the system's top inset is the whole of what
 * must be held back from the scroller.
 *
 * On the web every number here is zero and this is arithmetic on nothing, which
 * is why no call site has to ask what platform it is on.
 */
export function surfacePadding({
  systemInsets,
  frameInsets,
  frameViewport,
  framed,
  chrome = {},
}: {
  /** `useSafeAreaInsets()`. Zero on the web. */
  systemInsets: EdgePadding;
  /** `useFrame().contentInsets` — the whole sum. Only meaningful when `framed`. */
  frameInsets: EdgePadding;
  /** `useFrame().viewportInsets` — the part of it paid outside the scroller. */
  frameViewport: EdgePadding;
  /** Whether this surface is inside an `AppFrame` provider. */
  framed: boolean;
  chrome?: ChromeHeights;
}): SurfacePadding {
  const total = framed ? frameInsets : systemInsets;
  /*
    Outside a frame the bottom is left to the content on purpose: the home
    indicator is a thin translucent bar the platform draws *over* whatever is
    beneath it, and every one of these screens ends in a control that has to be
    scrollable clear of it. The top is the opposite — an opaque clock and a
    camera housing — and it is the edge the verification pass found text under.
  */
  const viewport = framed ? frameViewport : { top: systemInsets.top, bottom: 0 };
  const content = {
    top: total.top - viewport.top + (chrome.top ?? 0),
    bottom: total.bottom - viewport.bottom + (chrome.bottom ?? 0),
  };
  return {
    viewport,
    content,
    top: viewport.top + content.top,
    bottom: viewport.bottom + content.bottom,
  };
}

/**
 * Whether a selection in the tree should dismiss the explorer.
 *
 * **This takes the explorer's presentation now, not the density, and that is
 * the change its previous comment predicted.** It used to read
 * `closesOnSelect(density)` and answer `false` everywhere, above a note saying
 * it "stays a function of the density because that is the question it answers,
 * and the day a density puts the tree over the document again this is the line
 * that changes rather than the call site in `Explorer`". The tree is over the
 * document again — as a peek rather than a drawer, and at wide rather than at
 * compact — so the density was never the question. The presentation is.
 *
 * The rule itself is unchanged and is the one the drawer was written for: a
 * tree lying **over** the editor is covering the note you have just asked to
 * read, so leaving it up opens every note behind a panel. A tree **beside** the
 * editor must stay put — dismissing a permanent region because somebody clicked
 * inside it is how people stop using a file tree.
 *
 * `drawer` keeps its arm here although no density reaches it, for the reason
 * the file header gives: the representation and the rules about it are retired
 * together or not at all.
 */
export function closesOnSelect(explorer: Regions["explorer"]): boolean {
  return explorer === "drawer" || explorer === "peek";
}
