import { describe, expect, test } from "@jest/globals";
import { defaultContext, landingHref } from "../features/console/nav";

/**
 * Which context somebody lands in when they sign in and choose nothing.
 *
 * ## The bug
 *
 * It was "the first of the list", and the list is ordered by nothing a person
 * would recognise. So an account that owns `@agent` and was invited into
 * `@seyi` signed in and got **`@seyi`**: a context they are a guest in,
 * filtered to team level, with a "Team access — notes marked private are not
 * shown here" line across the top and their own brain nowhere on the screen.
 * Every part of that is working as designed and the whole of it is the wrong
 * first screen.
 *
 * It was that in **two** places — the selection in `useLiveConsoleData` and the
 * URL `/console` redirects to — and fixing only the first fixes nothing,
 * because `resolveContextRoute` selects whatever the URL names. Hence one
 * function and the `landingHref` case at the bottom of this file.
 *
 * ## Why owning is the rule rather than, say, the newest
 *
 * A brain is what the product is: where capture lands, where the privacy
 * manifest lives, and the only context whose private notes the signed-in person
 * can see at all. A context somebody shared with you is a place you visit.
 * There is exactly one personal context per person (`CLAUDE.md`, "Brain"), so
 * "one you own" is not ambiguous in practice — and where it somehow is, the
 * first of the owned ones is still strictly better than the first of all of
 * them.
 */
describe("the context the console opens on", () => {
  test("prefers one you own over one you were invited into", () => {
    expect(
      defaultContext([
        { id: "seyi", role: "member" },
        { id: "agent", role: "owner" },
      ])?.id,
    ).toBe("agent");
  });

  test("does not depend on where in the list it is", () => {
    // The bug was positional, so the fix is checked from both ends.
    expect(
      defaultContext([
        { id: "agent", role: "owner" },
        { id: "seyi", role: "member" },
      ])?.id,
    ).toBe("agent");
  });

  test("falls back to the first when you own none", () => {
    /*
      A real state, not a defensive one: somebody invited into a colleague's
      context before finishing their own onboarding owns nothing yet, and
      landing them nowhere would be worse than landing them somewhere they can
      read.
    */
    expect(
      defaultContext([
        { id: "lk", role: "editor" },
        { id: "seyi", role: "member" },
      ])?.id,
    ).toBe("lk");
  });

  test("an empty set answers null rather than inventing a context", () => {
    // A session resolves to a *set*, and it is empty for a moment on every cold
    // load and indefinitely for somebody part-way through onboarding.
    expect(defaultContext([])).toBeNull();
  });

  test("a role this build has never heard of is not treated as ownership", () => {
    // The comparison is against the string, so a future role cannot quietly
    // become "yours" by going unrecognised.
    expect(
      defaultContext([
        { id: "one", role: "auditor" },
        { id: "two", role: "owner" },
      ])?.id,
    ).toBe("two");
  });

  test("and the URL the landing redirects to obeys the same rule", () => {
    // The half that actually decided it on a device: the selection was already
    // right and `/console` redirected over the top of it.
    expect(
      landingHref([
        { slug: "seyi", role: "member" },
        { slug: "agent", role: "owner" },
      ]),
    ).toBe("/console/@agent");
  });
});
