/**
 * What a collect link's ceiling may be, in one place both ends import.
 *
 * The mint validates a cap and the submission spends against it, and those are
 * two files — `shares.ts` and `collect.ts` — with no reason to import each
 * other. A constant duplicated across that boundary is a constant that drifts,
 * and the direction it drifts in here is "the mint allowed more than the
 * spender enforces", which reads as the cap silently not working.
 *
 * `shareSlug.ts` is the precedent: the rule for a value several callers must
 * agree on lives beside neither of them.
 */

/**
 * How many answers a collect link takes before it stops, absent an owner's own
 * number.
 *
 * A ceiling rather than a judgement about how popular a form should be: it is
 * what stands between a published URL and somebody's whole storage quota while
 * they are asleep. An owner who wants more sets more, up to `MAX_COLLECT_CAP`.
 */
export const DEFAULT_COLLECT_CAP = 500;

/**
 * The most answers an owner may set one link to take.
 *
 * A ceiling on the ceiling. The cap exists so that a published URL cannot
 * become somebody's whole storage quota while they are asleep, and a cap an
 * owner can set to a million is not that — an agent that "helpfully" passed a
 * huge number would have removed the protection on their behalf. Ten thousand
 * answers is far past any real intake form and far short of a bucket.
 */
export const MAX_COLLECT_CAP = 10_000;

/**
 * A cap as a row may hold it, or `null` for "not a number I will store".
 *
 * `null` means the caller said nothing usable and the default stands — never
 * that the cap is unlimited, which is the one reading that would turn a typo
 * into an open door. Non-integers, zero, negatives, `NaN` and anything past
 * the maximum all land there, and none of them is an error: an owner who
 * typed something odd gets a working link with the default ceiling rather
 * than no link.
 */
export function collectCapFrom(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_COLLECT_CAP) return null;
  return value;
}
