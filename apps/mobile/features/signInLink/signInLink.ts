import { loginHref, safeNextRoute } from "../auth/redirect";

/** What opening a link Tex texted answers (`functions/textSignIn.ts`). */
export type OpenAnswer = { status: "spent"; next?: string } | { status: "open"; phone: string; code: string; next: string };

/**
 * Where the page goes once it knows: the link's own destination once signed
 * in, or the ordinary sign-in on the way there when the link is spent or the
 * sign-in was refused. Every destination is narrowed by `safeNextRoute`, so a
 * link can never send anybody off the app.
 */
export function afterOpening(answer: OpenAnswer, signedIn: boolean): string {
  if (answer.status === "open" && signedIn) return safeNextRoute(answer.next);
  return loginHref(answer.next ?? null);
}
