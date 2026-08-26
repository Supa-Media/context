import { describe, expect, test } from "@jest/globals";
import {
  WELCOME_ROUTE,
  isWelcomePath,
  needsOnboarding,
  resolveWelcomeRoute,
} from "../features/onboarding/route";
import { CONSOLE_ROUTE } from "../features/auth/redirect";

/**
 * The routing rules for a brand-new account.
 *
 * Every one of these is a rule about a *redirect*, which is the category of
 * bug that looks fine when you click through it and strands somebody when they
 * reload. The one that matters most is at the bottom: a query that has not
 * resolved is not an empty list, and confusing the two throws established users
 * into onboarding.
 */

describe("recognising the welcome route", () => {
  test("matches the route itself", () => {
    expect(isWelcomePath("/welcome")).toBe(true);
  });

  test("ignores a query string and a hash", () => {
    expect(isWelcomePath("/welcome?from=login")).toBe(true);
    expect(isWelcomePath("/welcome#step")).toBe(true);
  });

  test("ignores a trailing slash", () => {
    expect(isWelcomePath("/welcome/")).toBe(true);
  });

  test("is not the console, and not a context that happens to start the same", () => {
    expect(isWelcomePath("/console")).toBe(false);
    expect(isWelcomePath("/welcomes")).toBe(false);
    expect(isWelcomePath("/console/@welcome")).toBe(false);
  });
});

describe("the (app) gate", () => {
  test("sends an account with no contexts to onboarding, from anywhere", () => {
    for (const pathname of ["/console", "/console/connections", "/console/@seyi/settings"]) {
      expect(needsOnboarding({ contextCount: 0, pathname })).toEqual({
        action: "redirect",
        href: WELCOME_ROUTE,
      });
    }
  });

  test("leaves an account that has contexts alone", () => {
    expect(needsOnboarding({ contextCount: 1, pathname: "/console" })).toEqual({
      action: "render",
    });
  });

  test("never redirects away from the flow it just sent someone to", () => {
    expect(needsOnboarding({ contextCount: 0, pathname: "/welcome" })).toEqual({
      action: "render",
    });
  });

  test("does not eject someone mid-flow once step 1 has created a context", () => {
    // The moment `createWorkspace` returns, the count goes 0 → 1. The gate must
    // not treat that as "you're done here".
    expect(needsOnboarding({ contextCount: 1, pathname: "/welcome" })).toEqual({
      action: "render",
    });
  });

  test("an unresolved context list renders rather than redirecting", () => {
    // The bug this guards: `undefined` read as "no contexts" bounces a user
    // with three contexts into onboarding on every cold load.
    expect(needsOnboarding({ contextCount: undefined, pathname: "/console" })).toEqual({
      action: "render",
    });
  });
});

describe("the welcome screen's own gate", () => {
  test("runs the flow for an account with no contexts", () => {
    expect(resolveWelcomeRoute({ contextCount: 0, claimed: false })).toEqual({
      action: "render",
    });
  });

  test("is not re-runnable: an account that already has a context goes to the console", () => {
    expect(resolveWelcomeRoute({ contextCount: 2, claimed: false })).toEqual({
      action: "redirect",
      href: CONSOLE_ROUTE,
    });
  });

  test("waits rather than deciding while the list is still loading", () => {
    // Not "render" — rendering step 1 to somebody who already has contexts and
    // then yanking it away is the flash this avoids.
    expect(resolveWelcomeRoute({ contextCount: undefined, claimed: false })).toEqual({
      action: "wait",
    });
  });

  test("stays put once a name has been claimed in this session", () => {
    // The whole reason `claimed` exists. Without it, finishing step 1 bounces
    // the user into a console with no bucket connected.
    expect(resolveWelcomeRoute({ contextCount: 1, claimed: true })).toEqual({
      action: "render",
    });
  });

  test("a claim in flight outranks a list that has not loaded", () => {
    expect(resolveWelcomeRoute({ contextCount: undefined, claimed: true })).toEqual({
      action: "render",
    });
  });
});
