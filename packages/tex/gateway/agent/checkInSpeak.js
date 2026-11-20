/**
 * A CHECK-IN THAT FOUND MAIL WORTH A TEXT DOES NOT STAY QUIET ON THE FIRST TRY
 * (2026-11-18).
 *
 * The check-in's instructions say most looks stay quiet, and a newsletter, a
 * receipt or marketing is not worth a text. Training already splits the rest:
 * an approval that leaves out the facts, or a commitment coming up, is said,
 * with the next step offered and not started. The model follows "stay quiet"
 * past that mail. The first `say_nothing` on worth-mail is refused once
 * (`sayNothingOnce`). A second silence stands, and a newsletter still ends
 * on the first call.
 */

const NOT_WORTH = /\b(?:newsletter|unsubscribe|receipt|marketing|notification|% off|percent off|\bsale\b)/i;

/** True when any line of new mail is not a newsletter, a receipt or marketing. */
export function mailWorthAText(lines) {
  const list = Array.isArray(lines) ? lines : [String(lines ?? "")];
  return list.some((line) => {
    const text = String(line ?? "").trim();
    return text !== "" && !NOT_WORTH.test(text);
  });
}

export const CHECK_IN_SPEAK_NOTICE =
  "Before this goes: this look found mail that is not a newsletter, a receipt or marketing. " +
  "Text what came in and what it leaves out, and offer the next step. Don't start that step.";
