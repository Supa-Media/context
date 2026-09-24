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
