/**
 * What the early-beta notice does, from two answers: whether this device has
 * a "Got it" stored, and whether the account has one (`betaNoticeSeen`).
 *
 * - `wait`: an answer is still coming; show nothing rather than flash it.
 * - `hide`: dismissed somewhere, or nobody signed in.
 * - `carry`: dismissed on this device before the account kept it; tell the
 *   account, so no other device asks again.
 * - `show`: dismissed nowhere.
 *
 * `unavailable` is a backend that cannot answer (a deploy behind, or down):
 * the device's copy decides, as it did before the account kept one.
 */

export type BetaNoticeStep = "wait" | "hide" | "carry" | "show";

export function betaNoticeStep({
  device,
  account,
}: {
  device: boolean | undefined;
  account: boolean | null | undefined | "unavailable";
}): BetaNoticeStep {
  if (device === undefined || account === undefined) return "wait";
  if (account === null) return "hide";
  if (account === "unavailable") return device ? "hide" : "show";
  if (account) return "hide";
  return device ? "carry" : "show";
}
