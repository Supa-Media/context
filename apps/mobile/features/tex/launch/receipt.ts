/**
 * The waitlist status receipt, kept in this origin's storage
 * (`apps/convex/functions/lib/waitlistReceipt.ts` says what it is).
 *
 * Only ever here and in a function argument: never in a URL, so it cannot
 * reach an address bar, a referrer, a pixel or a log. Storage can be missing
 * or throw (a private window, blocked site data), and then there is simply no
 * receipt: the page says it cannot find a place from this browser, which is
 * true, and the person still gets the "You're in" text.
 */

const KEY = "context.waitlistReceipt";
const SHAPE = /^[0-9a-f]{64}$/;

export function readReceipt(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(KEY) ?? null;
    return value !== null && SHAPE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveReceipt(receipt: string): void {
  if (!SHAPE.test(receipt)) return;
  try {
    globalThis.localStorage?.setItem(KEY, receipt);
  } catch {
    // No storage: the page falls back to "we can't find your spot here".
  }
}

/** "Not you?": this browser forgets the place it was holding. */
export function forgetReceipt(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}
