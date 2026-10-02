/**
 * What an owner reads when managed storage could not be set up. Split out of
 * `premium.ts`, which re-exports it.
 */

/**
 * Storage was paid for and could not be made.
 *
 * The worst state in the product — money taken, nothing delivered — and the
 * three things this copy has to do, in order:
 *
 * 1. **Say the payment and the notes are safe**, before anything else.
 * 2. **Say a retry cannot duplicate anything.** That is a fact rather than
 *    reassurance: provisioning adopts the bucket named for this workspace, and
 *    `apps/convex/__tests__/managedProvisioning.test.ts` holds it to that.
 * 3. **Offer the free path out** — connect storage of your own — because it
 *    always works, and somebody stuck here has already waited long enough.
 *
 * The error code is ours and is never rendered: a person reading this cannot
 * act on which of our systems refused, and a provider's own text can name an
 * account. It picks the sentence, and the sentence names the next safe action.
 */
export function managedFailureCopy(errorCode: string | undefined): {
  title: string;
  body: string;
  canRetry: boolean;
} {
  if (errorCode === "NOT_CONFIGURED") {
    return {
      title: "We cannot set up storage on this deployment yet",
      body:
        "Your payment went through and nothing has been lost. This one is at our " +
        "end and trying again will not fix it — get in touch and we will sort it " +
        "out, or connect storage you own and we will stop the subscription.",
      canRetry: false,
    };
  }
  if (errorCode === "MOVE_IN_PROGRESS") {
    return {
      title: "Your files are being moved to another bucket",
      body:
        "Nothing has been lost. Context storage is set up once that move has " +
        "finished or been stopped in Settings › Storage; then try again here.",
      canRetry: true,
    };
  }
  return {
    title: "We could not finish setting up your storage",
    body:
      "Your payment went through and nothing has been lost. This is our end, not " +
      "yours — trying again is safe and will not create a second copy of anything.",
    canRetry: true,
  };
}
