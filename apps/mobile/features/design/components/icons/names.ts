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
  /**
   * Its mirror: the right panel's toggle, a pane with its *trailing* column
   * filled.
   *
   * Drawn rather than reusing `panelLeft` flipped, because this set has no
   * mirroring primitive and a `scaleX(-1)` transform on a `View` full of
   * absolutely positioned children is a different thing on native and on web.
   * Two rects is cheaper than one transform anybody has to reason about.
   *
   * The pair is the point: the console reads as symmetric — a panel each side,
   * each with one toggle in the same bar — rather than as having something
   * bolted on.
   */
  "panelRight",
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
  /**
   * Copy, drawn as the two sheets every platform draws it as.
   *
   * Added for the Copy control on a meeting note — at the time, the only way
   * the text of a meeting got off the device at all; now the way out for one
   * the queue has not landed yet. It is deliberately not `share`: that mark already means "mint a
   * link somebody else can follow", and one glyph meaning two things is the
   * confusion `docs/decisions/meetings.md` refuses for the microphone.
   */
  "copy",
  /**
   * Recent, drawn as a clock because every platform draws recency as one.
   *
   * Deliberately not an `undo`-style curved arrow: that mark means "put this
   * back" everywhere else in this set, and the sheet it opens does not undo
   * anything — it lists where you have been. It replaced the tab-count square,
   * which was a number rather than a drawing; see `RecentSheet.tsx` for why the
   * number went.
   */
  "clock",
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
   * The accessory bar's bullet-list key, A1 in the editor-polish sweep:
   * "the more common of the two [prefixes] by a distance", and the bar could
   * only make a `- [ ] ` and not a `- ` before this. Three dots and three
   * rules rather than `sort`'s descending stack — a list's rows do not shrink,
   * so drawing them at one length is what tells the two marks apart at 20pt.
   */
  "bulletList",
  /**
   * The accessory bar's link key, A2 in the editor-polish sweep: `[[]]`,
   * caret between the brackets, completion opened. Two offset capsule rings
   * rather than `attach`'s nested pair — a chain link overlaps its neighbour,
   * it does not sit inside it, and the two shapes need to read apart at 20pt
   * on the same bar.
   */
  "link",
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
   * The note toolbar's Share, in the group at the top-right of a phone, and
   * the trailing action on the pointer layout's note header.
   *
   * iOS's arrow out of a tray. This was the share *graph* — three nodes and
   * two edges — on the argument that a share here grants somebody a way in to
   * a note that stays where it is, which is a relationship rather than a
   * departure. The argument is still true and it lost anyway, to the owner
   * asking for this glyph with a picture of it: the graph is also Android's
   * share mark, so the distinction it was drawing was never read as one, and
   * at 17pt three discs and two bars read as a smudge — the finding at the top
   * of this file, in a mark rather than a character.
   *
   * The landing page's third assurance panel — "Leaving is free, on both
   * plans" — carries this too, and it got better out of the change rather than
   * merely surviving it: an arrow lifting out of a tray is the export, which
   * is what that panel is about.
   */
  "share",
  /**
   * Reading mode, as an eye — and one of the two drawings in this file that is
   * a `<Path>` rather than a stack of `View`s. The header says why.
   *
   * Added with the control it is for — the note's read toggle — which is this
   * set's stated rule. It is deliberately not `book`: that mark is the docs
   * link in Settings, and one glyph meaning both "open the manual" and "stop
   * editing this note" is the confusion `copy` and `share` are kept apart to
   * avoid.
   *
   * Two arcs of one circle meeting in a point at each canthus, with the iris a
   * ring inside them. Filled, the iris reads as a bullet in a bracket at small
   * sizes and the mark stops being an eye.
   */
  "eye",
  /**
   * Its other half: the same control while the note is already in reading
   * mode, so the glyph names the act rather than the state.
   *
   * This is what let the read toggle stop carrying its state as an accent
   * fill. One mark cannot draw "will hide the markup" and "will bring it back",
   * which is the argument the old comment here made for lighting the button
   * instead; two marks can, and a lit *pencil* would say "pencil mode is on" —
   * the opposite of what pressing it does.
   *
   * A pencil rather than a sheet with a nib, or a pen: a pencil is the mark
   * every editor on both platforms uses for "edit this", and the collar across
   * the barrel is the one detail that keeps it from reading as a felt marker
   * at 17pt. The lead is a 48° point, rounded by the join — sharper reads as a
   * needle, blunter as a crayon.
   */
  "pencil",
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

  /* ------------------------------------------------------------------ *
   * The settings list.
   *
   * Nineteen destinations set in one weight, with no mark on any of them, is
   * a list that has to be *read* rather than scanned — `BottomBar`'s finding
   * at the top of this file, one screen further down. These are the marks
   * that let the eye find a row by its shape.
   *
   * Four sections take marks that already exist and mean the right thing:
   * `mic` for Meetings, `lock` for Privacy, `share` for Shared links, and
   * `search` for Search. A fifth would have been `gear` for Advanced, and it
   * is not: `gear` is how settings itself is reached, and a row inside
   * settings wearing the mark that opens settings is a loop.
   * ------------------------------------------------------------------ */

  /** AI apps: four panes, which is what a set of connected clients looks like. */
  "grid",
  /** Profile — one head over one pair of shoulders. */
  "person",
  /** People: two heads over one silhouette, so the plural is the drawing. */
  "people",
  /**
   * Groups — three heads and no shoulders.
   *
   * Deliberately not `people` with a third head added: at 18pt that reads as
   * `people` drawn badly. A cluster with no body is a *set*, which is what a
   * group is, and it cannot be mistaken for the row above it.
   */
  "group",
  /** Email: an envelope, flap down. */
  "mail",
  /**
   * Invitations — the same envelope with the flap open.
   *
   * A pair that differs at one end, like `undo`/`redo` above: two unrelated
   * marks for two kinds of mail would be two things to learn, and these are
   * the same thing in two states.
   */
  "mailOpen",
  "calendar",
  /** Chats: a bubble with a tail and the three dots every platform draws. */
  "chat",
  /** Your devices — a laptop, because that is the only machine that captures. */
  "laptop",
  /**
   * Appearance, as a sun.
   *
   * A crescent would be the better half of the usual pair and this set cannot
   * draw one: a crescent is a disc with a disc bitten out of it, and there is
   * no clipping here — see the header. A sun with four rays is the half that
   * is drawable, and it is what the row means either way: how this looks.
   */
  "sun",
  /** Sign out & delete: a door with the way out beside it. */
  "signOut",
  /** Overview — the section that only tells you things. */
  "info",
  /** Premium: a card, which is the thing the section actually changes. */
  "card",
  /**
   * Storage — two bays, not a cylinder.
   *
   * A database cylinder needs an ellipse, which React Native's border radii do
   * not make reliably across both platforms; `globe` records the same refusal
   * two drawings up.
   */
  "drive",
  /** Advanced: two sliders, off their defaults. */
  "sliders",
  /**
   * Plugins — a board with one piece joined to its corner.
   *
   * Not a puzzle piece, which is the obvious mark and undrawable here: a
   * jigsaw tab is a path with two concave shoulders, and there is no clipping
   * in this set (see `globe` and `drive`, which record the same refusal). Two
   * rounded rectangles meeting at a corner say the thing that actually matters
   * about this section anyway — something of somebody else's, attached to
   * what you already have — and the filled one is the *added* half, so the
   * drawing has a subject.
   *
   * Deliberately not `grid`, which is AI apps: four equal panes are a set of
   * peers, and a plugin is not a peer of the vault it runs against.
   */
  "plugin",
  /**
   * The Model row: a big four-point star with a small one beside it.
   *
   * Two crossed bars is `plus`, which this set already uses for "add". The
   * second, smaller star is what makes this a different mark rather than a
   * bigger one — and the pair is the glyph every product in this decade uses
   * for a model, so it needs no caption on a row that has none.
   */
  "sparkle",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
