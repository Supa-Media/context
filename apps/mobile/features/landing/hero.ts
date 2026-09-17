/**
 * How wide the hero heading is allowed to be.
 *
 * The mockup says `max-width: 14ch` on `.hero h1`. Porting that to React
 * Native means resolving `ch` by hand, because RN has no relative type units —
 * and the first port guessed. It used a flat `780px`, which is 14 characters
 * of a *typical* sans at 98px but not of the face actually in use, and the
 * result was a headline that wrapped to four lines at 1440px instead of two.
 * The dimmed half then dominated the page and pushed the console demo below
 * the fold, which is the one thing the landing design is built around.
 *
 * So the ratio is measured rather than estimated, and re-measured whenever the
 * face changes — which it now has: the display face was Onest and is Instrument
 * Sans, because a second humanist sans nobody could tell from the first was a
 * webfont that bought no identity.
 *
 * ## The measurement
 *
 * Taken in Chromium against the real woff2 from Google Fonts, at 98px,
 * `font-weight: 500`, with the mockup's `-0.035em` tracking on the lines. The
 * advance of "0" — which is what `ch` means — is measured without tracking,
 * because that is what the unit means.
 *
 *                       1ch@98px    14ch      "Notes for your team"
 *   Onest (was)          65.00px    910.0px    857.8px
 *   Instrument Sans      66.00px    924.0px    831.8px
 *
 * The method was validated against this file's own previous numbers before the
 * new ones were trusted: it reproduced Onest at 65.00px against the 65.02px
 * recorded here, and "Share your context." at 843.8px against 846.3px. A
 * measurement that cannot reproduce the last one is not a measurement.
 *
 * Instrument Sans is *wider* than Onest per character — 0.6735 against 0.6633 —
 * so the cap grows with the face and the margin grows with it. The current
 * longest line clears it by 92px.
 *
 * ## A correction worth keeping
 *
 * When the hero's words changed to "Notes for your team" / "and your agents.",
 * the note here claimed the new lines were "no longer than" the ones that had
 * been measured, on a character count: 19 and 16 against 19. That was wrong,
 * and it is exactly the kind of wrong this file exists to prevent. Measured in
 * Onest, the new longest line was **857.8px against the old 843.8px** — 14px
 * *wider*, not narrower. It fit, so nothing shipped broken, but it fit by
 * luck rather than by the reasoning given. Characters are not a proxy for
 * width: "Notes for your team" has four more wide lowercase letters and no
 * narrow `l`/`i`/`t` run to pay for them.
 *
 * Below the breakpoint the container is narrower than this anyway, so the
 * second sentence wraps on a phone — which is fine, and is what the mockup
 * does too.
 */

/** Instrument Sans's "0" advance, as a fraction of the font size. Measured. */
export const HERO_CH_RATIO = 0.6735;

/** The mockup's `max-width: 14ch`. */
export const HERO_MAX_CH = 14;

/** The widest of the two hero lines at 98px, measured in Instrument Sans. */
export const HERO_LONGEST_LINE_AT_98 = 831.8;

export function heroHeadingWidth(fontSize: number): number {
  return fontSize * HERO_CH_RATIO * HERO_MAX_CH;
}
