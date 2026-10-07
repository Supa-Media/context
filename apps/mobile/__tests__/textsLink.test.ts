import { describe, expect, test } from "@jest/globals";
import { linkMessage, resolveTextsLinkView, textsLinkHref } from "../features/texts/textsLink";

const signedIn = { isLoading: false, isAuthenticated: true };
const signedOut = { isLoading: false, isAuthenticated: false };
const fail = (code: string) => ({ kind: "failed" as const, error: { data: { code } } });

describe("the texted sign-in link", () => {
  test("waits for auth, then sends a signed-out visitor to sign in and back here", () => {
    expect(resolveTextsLinkView({ token: "abc", auth: { isLoading: true, isAuthenticated: false }, claim: { kind: "idle" } })).toEqual({ kind: "wait" });
    expect(resolveTextsLinkView({ token: "abc", auth: signedOut, claim: { kind: "idle" } })).toEqual({
      kind: "signIn",
      href: `/login?next=${encodeURIComponent("/texts/abc")}`,
    });
  });

  test("shows the message to text back, naming the phone by its last four digits only", () => {
    const view = resolveTextsLinkView({
      token: "abc",
      auth: signedIn,
      claim: { kind: "shown", code: "ABCD2345", phoneEnding: "0100", expiresAt: 1 },
    });
    expect(view).toEqual({ kind: "ready", message: "link ABCD2345", phoneEnding: "0100", expiresAt: 1 });
  });

  test("the message is what the assistant reads as a link command", () => {
    // Mirrors LINK_COMMAND in apps/agent/src/reply.ts.
    expect(linkMessage("ABCD2345")).toMatch(/^\s*link\s+([a-z0-9]{6,10})\s*[.!]?\s*$/i);
  });

  test("loads while the code is asked for", () => {
    for (const claim of [{ kind: "idle" as const }, { kind: "claiming" as const }]) {
      expect(resolveTextsLinkView({ token: "abc", auth: signedIn, claim }).kind).toBe("loading");
    }
  });

  test("an expired, replaced or missing link says to text again for a new one", () => {
    const dead = resolveTextsLinkView({ token: "abc", auth: signedIn, claim: fail("INVITE_DEAD") });
    expect(dead).toMatchObject({ kind: "dead", headline: "This link has expired" });
    expect(resolveTextsLinkView({ token: null, auth: signedIn, claim: { kind: "idle" } })).toEqual(dead);
  });

  test("other refusals say what to do, and a surprise says to reload", () => {
    expect(resolveTextsLinkView({ token: "abc", auth: signedIn, claim: fail("NO_PERSONAL_WORKSPACE") })).toMatchObject({ headline: "Set up your workspace first" });
    expect(resolveTextsLinkView({ token: "abc", auth: signedIn, claim: fail("RATE_LIMITED") })).toMatchObject({ headline: "Too many codes for now" });
    expect(resolveTextsLinkView({ token: "abc", auth: signedIn, claim: { kind: "failed", error: new Error("x") } })).toMatchObject({ headline: "We couldn't show your code" });
  });

  test("the token is a path segment, escaped", () => {
    expect(textsLinkHref("a/b")).toBe("/texts/a%2Fb");
  });
});
