/**
 * `/texts/<token>`: the link the texting assistant sends a phone nobody has
 * linked. Signed in, it shows the code to text back; the code only links the
 * phone the link was texted to, so this page names that phone by its last four
 * digits and nothing more.
 *
 * Pure so the tests can walk every state without a Convex client.
 */

import { errorCodeOf } from "../consent/state";
import { loginHref } from "../auth/redirect";

export const TEXTS_ROUTE = "/texts";

export function textsLinkHref(token: string): string {
  return `${TEXTS_ROUTE}/${encodeURIComponent(token)}`;
}

/** What the backend handed back for this link. */
export type Claim =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "shown"; code: string; phoneEnding: string; expiresAt: number }
  | { kind: "failed"; error: unknown };

export type TextsLinkView =
  | { kind: "wait" }
  | { kind: "signIn"; href: string }
  | { kind: "loading" }
  | { kind: "ready"; message: string; phoneEnding: string; expiresAt: number }
  | { kind: "dead"; headline: string; detail: string };

/** What the person sends back. The Worker reads `link CODE` in any case. */
export function linkMessage(code: string): string {
  return `link ${code}`;
}

export function resolveTextsLinkView(inputs: {
  token: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  claim: Claim;
}): TextsLinkView {
  if (inputs.auth.isLoading) return { kind: "wait" };
  if (inputs.token === null) return DEAD;
  if (!inputs.auth.isAuthenticated) return { kind: "signIn", href: loginHref(textsLinkHref(inputs.token)) };
  const claim = inputs.claim;
  if (claim.kind === "idle" || claim.kind === "claiming") return { kind: "loading" };
  if (claim.kind === "shown") {
    return {
      kind: "ready",
      message: linkMessage(claim.code),
      phoneEnding: claim.phoneEnding,
      expiresAt: claim.expiresAt,
    };
  }
  return describeFailure(claim.error);
}

const DEAD: TextsLinkView = {
  kind: "dead",
  headline: "This link has expired",
  detail: "Links work for 30 minutes. Text your Context again and it will send you a new one.",
};

function describeFailure(error: unknown): TextsLinkView {
  switch (errorCodeOf(error)) {
    case "INVITE_DEAD":
      return DEAD;
    case "NO_PERSONAL_WORKSPACE":
      return {
        kind: "dead",
        headline: "Set up your workspace first",
        detail: "Texts answer from your own workspace, and this account doesn't have one yet. Finish setting up Context, then open this link again.",
      };
    case "RATE_LIMITED":
      return {
        kind: "dead",
        headline: "Too many codes for now",
        detail: "Wait a little while, then open this link again.",
      };
    default:
      return {
        kind: "dead",
        headline: "We couldn't show your code",
        detail: "Something went wrong on our side. Reload this page to try again.",
      };
  }
}
