import { describe, expect, test } from "@jest/globals";
import { defaultContextId } from "../features/console/types";

/**
 * Which context somebody lands in when they sign in and choose nothing.
 *
 * ## The bug
 *
 * It was `workspaces[0]`, and the workspace list is ordered by nothing a person
 * would recognise. So an account that owns `@agent` and is a member of `@seyi`
 * signed in and got **`@seyi`**: a context they are a guest in, filtered to team
 * level, with a "Team access — notes marked private are not shown here" line
 * across the top and their own brain nowhere on the screen. Every part of that
 * is working as designed and the whole of it is the wrong first screen.
 *
 * ## Why owning is the rule rather than, say, the newest
 *
 * A brain is what the product is: it is where capture lands, where the privacy
 * manifest lives, and the only context whose private notes the signed-in person
 * can see at all. A context somebody shared with you is a place you visit.
 * There is exactly one personal context per person (`CLAUDE.md`, "Brain"), so
 * "one you own" is not ambiguous in practice — and where it somehow is, taking
 * the first of the owned ones is still strictly better than taking the first of
 * all of them.
 */
describe("the context the console opens on", () => {
  test("prefers one you own over one you were invited into", () => {
    expect(
      defaultContextId([
        { id: "seyi", role: "member" },
        { id: "agent", role: "owner" },
      ]),
    ).toBe("agent");
  });

  test("does not depend on where in the list it is", () => {
    // The bug was positional, so the fix has to be checked from both ends.
    expect(
      defaultContextId([
        { id: "agent", role: "owner" },
        { id: "seyi", role: "member" },
      ]),
    ).toBe("agent");
  });

  test("falls back to the first when you own none", () => {
    /*
      A real state, not a defensive one: somebody invited into a colleague's
      context before finishing their own onboarding owns nothing yet, and
      landing them on the map with no context selected would be worse than
      landing them somewhere they can read.
    */
    expect(
      defaultContextId([
        { id: "lk", role: "editor" },
        { id: "seyi", role: "member" },
      ]),
    ).toBe("lk");
  });

  test("an empty set answers null rather than inventing a context", () => {
    // A session resolves to a *set*, and it is empty for a moment on every cold
    // load and indefinitely for somebody part-way through onboarding.
    expect(defaultContextId([])).toBeNull();
  });

  test("a role this build has never heard of is not treated as ownership", () => {
    // The comparison is against the string, so a future role cannot quietly
    // become "yours" by being unrecognised.
    expect(
      defaultContextId([
        { id: "one", role: "auditor" },
        { id: "two", role: "owner" },
      ]),
    ).toBe("two");
  });
});
