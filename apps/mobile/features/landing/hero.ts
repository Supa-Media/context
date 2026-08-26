/**
 * How wide the hero heading is allowed to be.
 *
 * The mockup says `max-width: 14ch` on `.hero h1`. Porting that to React
 * Native means resolving `ch` by hand, because RN has no relative type units —
 * and the first port guessed. It used a flat `780px`, which is 14 characters
 * of a *typical* sans at 98px but not of Onest, and the result was a headline
 * that wrapped to four lines at 1440px instead of two. The dimmed half then
 * dominated the page and pushed the console demo below the fold, which is the
 * one thing the landing design is built around.
 *
 * So the ratio is measured rather than estimated. In Onest at
 * `font-weight: 500`, the advance of "0" — which is what `ch` means — is
 * **0.6635em**, so `14ch` is `fontSize × 9.29`. Measured in the real web build
 * at 98px: `1ch = 65.02px`, `14ch = 910.2px`.
 *
 * For scale, at 98px the two lines measure (with the mockup's `-0.035em`
 * tracking):
 *
 *   "Free your context."   787.5px
 *   "Share your context."  846.3px
 *
 * — both inside 910, which is why the mockup holds each on one line and why
 * the old 780 could not. Those numbers are the reason `HERO_CH_RATIO` is a
 * named constant with a test rather than a magic number: if somebody trims it
 * for a "tighter" hero, the test says what it would break.
 *
 * Below the breakpoint the container is narrower than this anyway, so the
 * second sentence wraps to two lines on a phone — which is fine, and is what
 * the mockup does too.
 */

/** Onest's "0" advance, as a fraction of the font size. Measured, not guessed. */
export const HERO_CH_RATIO = 0.6635;

/** The mockup's `max-width: 14ch`. */
export const HERO_MAX_CH = 14;

/** The widest of the two hero lines at 98px, measured in the real build. */
export const HERO_LONGEST_LINE_AT_98 = 846.3;

export function heroHeadingWidth(fontSize: number): number {
  return fontSize * HERO_CH_RATIO * HERO_MAX_CH;
}
