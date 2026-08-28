import { describe, expect, test } from "@jest/globals";
import {
  WELCOME_ROUTE,
  isWelcomePath,
  needsOnboarding,
  resolveWelcomeRoute,
  ownedContexts,
  standingFrom,
  type ContextStanding,
} from "../features/onboarding/route";
import { CONSOLE_ROUTE, INVITE_ROUTE } from "../features/auth/redirect";

/**
 * The routing rules for a brand-new account.
 *
 * Every one of these is a rule about a *redirect*, which is the category of
 * bug that looks fine when you click through it and strands somebody when they
 * reload. Two matter most. A query that has not resolved is not an empty list,
 * and confusing the two throws established users into onboarding. And an
 * account's *standing* is three separate facts — what it owns, what it can
 * reach, what it has been invited to — which is the distinction that decides
 * whether somebody who was invited into a context can ever have one of their
 * own.
 */

/** A standing with everything at zero, to be spread over. */
const NOTHING: ContextStanding = { owned: 0, reachable: 0, invitations: 0 };

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

describe("reading a standing off the two subscriptions", () => {
  test("counts an owned personal context as owned, reachable and nothing else", () => {
    expect(standingFrom([{ kind: "personal", role: "owner" }], [])).toEqual({
      owned: 1,
      reachable: 1,
      invitations: 0,
    });
  });

  test("somebody else's context is reachable but not owned", () => {
    // The case the old single count could not express, and the reason an
    // invitee could never onboard.
    expect(standingFrom([{ kind: "personal", role: "member" }], [])).toEqual({
      owned: 0,
      reachable: 1,
      invitations: 0,
    });
  });

  test("a shared context is not a personal one, whatever the role", () => {
    // Owning a `shared` workspace is not the thing onboarding produces, so it
    // must not count as having run the flow.
    expect(standingFrom([{ kind: "shared", role: "owner" }], [])).toEqual({
      owned: 0,
      reachable: 1,
      invitations: 0,
    });
  });

  test("an unresolved workspace list is unknown, not empty", () => {
    expect(standingFrom(undefined, [])).toBeUndefined();
  });

  test("ownedContexts answers from the workspace list alone", () => {
    // The welcome gate asks only this, so it must not need the invitation
    // subscription — a controller forced to open one for a number it never
    // reads is a round trip bought for nothing.
    expect(ownedContexts([{ kind: "personal", role: "owner" }])).toBe(1);
    expect(ownedContexts([{ kind: "personal", role: "member" }])).toBe(0);
    expect(ownedContexts(undefined)).toBeUndefined();
  });

  test("an unresolved invitation list is unknown for anybody who has a context", () => {
    // The subtle one. A standing built from a landed workspace list and an
    // in-flight invitation list reads `invitations: 0`, which is precisely the
    // shape that means "send this person to onboarding" — so an invitee whose
    // second query is a few milliseconds slower would be bounced anyway, some
    // of the time.
    expect(standingFrom([{ kind: "personal", role: "member" }], undefined)).toBeUndefined();
  });

  test("but somebody who can reach nothing is still sent to onboarding", () => {
    // The failure this closes: `usable()` maps a *persistent* query error to
    // `undefined` as well as an in-flight one, so a control plane that cannot
    // answer `listMyInvitations` at all would leave the standing permanently
    // unresolved — and an unresolved standing renders. A brand-new account
    // would sit in an empty console with no route to `/welcome` forever, which
    // is worse than the behaviour before the invitation list was consulted.
    //
    // One hop is the cost to a real invitee, and claiming a name neither
    // spends nor hides an invitation.
    expect(standingFrom([], undefined)).toEqual({
      owned: 0,
      reachable: 0,
      invitations: 0,
    });
  });
});

describe("the (app) gate", () => {
  test("sends a genuinely empty account to onboarding, from anywhere", () => {
    for (const pathname of ["/console", "/console/connections", "/console/@seyi/settings"]) {
      expect(needsOnboarding({ standing: NOTHING, pathname })).toEqual({
        action: "redirect",
        href: WELCOME_ROUTE,
      });
    }
  });

  test("leaves an account that has contexts alone", () => {
    expect(
      needsOnboarding({ standing: { ...NOTHING, owned: 1, reachable: 1 }, pathname: "/console" }),
    ).toEqual({ action: "render" });
  });

  test("leaves alone somebody whose only context belongs to someone else", () => {
    // Being given a context is having somewhere to be. Prompting them to build
    // their own is a banner's job, not a redirect's.
    expect(
      needsOnboarding({ standing: { ...NOTHING, reachable: 1 }, pathname: "/console" }),
    ).toEqual({ action: "render" });
  });

  test("sends somebody with a pending invitation to the invitation, not to onboarding", () => {
    // The referral this whole flow exists to protect. They have nothing yet,
    // but somebody sent them here, and "claim your name" is not what they came
    // for — they would never even learn an invitation was waiting.
    expect(
      needsOnboarding({ standing: { ...NOTHING, invitations: 1 }, pathname: "/console" }),
    ).toEqual({ action: "redirect", href: INVITE_ROUTE });
  });

  test("a context you can already open outranks an invitation you have not answered", () => {
    expect(
      needsOnboarding({
        standing: { owned: 1, reachable: 1, invitations: 1 },
        pathname: "/console",
      }),
    ).toEqual({ action: "render" });
  });

  test("never redirects away from the flow it just sent someone to", () => {
    expect(needsOnboarding({ standing: NOTHING, pathname: "/welcome" })).toEqual({
      action: "render",
    });
  });

  test("nor away from the invitation it just sent someone to", () => {
    // Without this the redirect points at the page doing the redirecting.
    for (const pathname of ["/invite", "/invite/9f2c41", "/invite/9f2c41?from=mail"]) {
      expect(needsOnboarding({ standing: { ...NOTHING, invitations: 1 }, pathname })).toEqual({
        action: "render",
      });
    }
  });

  test("does not eject someone mid-flow once step 1 has created a context", () => {
    // The moment `createWorkspace` returns, the counts go 0 → 1. The gate must
    // not treat that as "you're done here".
    expect(
      needsOnboarding({ standing: { ...NOTHING, owned: 1, reachable: 1 }, pathname: "/welcome" }),
    ).toEqual({ action: "render" });
  });

  test("an unresolved standing renders rather than redirecting", () => {
    // The bug this guards: `undefined` read as "nothing" bounces a user with
    // three contexts into onboarding on every cold load.
    expect(needsOnboarding({ standing: undefined, pathname: "/console" })).toEqual({
      action: "render",
    });
  });
});

describe("the welcome screen's own gate", () => {
  test("runs the flow for an account that owns nothing", () => {
    expect(resolveWelcomeRoute({ owned: 0, claimed: false })).toEqual({
      action: "render",
    });
  });

  /**
   * `resume=structure` is a Dropbox connect that left first-run for the OAuth
   * redirect and came back. The person owns a context *because step 1 ran*;
   * without this flag the gate bounces them to the console and the layout and
   * agents steps never happen — which is exactly how the first live connect
   * failed.
   */
  test("resuming renders for an owner instead of bouncing to the console", () => {
    expect(resolveWelcomeRoute({ owned: 1, claimed: false, resuming: true })).toEqual({
      action: "render",
    });
  });

  test("resuming still waits while the workspace list is outstanding", () => {
    expect(
      resolveWelcomeRoute({ owned: undefined, claimed: false, resuming: true }),
    ).toEqual({ action: "wait" });
  });

  test("a typed resume param for somebody who owns nothing is just onboarding", () => {
    expect(resolveWelcomeRoute({ owned: 0, claimed: false, resuming: true })).toEqual({
      action: "render",
    });
  });

  test("still runs for somebody who has accepted an invitation but owns nothing", () => {
    // The lock-out this replaced: accepting Seyi's invitation gave them a
    // workspace, the old rule read that as "already onboarded", and there was
    // no path left to claiming a name or connecting a bucket. Ever.
    expect(
      resolveWelcomeRoute({ owned: ownedContexts([{ kind: "personal", role: "member" }]), claimed: false }),
    ).toEqual({ action: "render" });
  });

  test("is not re-runnable: an account that owns a context goes to the console", () => {
    expect(
      resolveWelcomeRoute({ owned: 1, claimed: false }),
    ).toEqual({ action: "redirect", href: CONSOLE_ROUTE });
  });

  test("waits rather than deciding while the standing is still loading", () => {
    // Not "render" — rendering step 1 to somebody who already has contexts and
    // then yanking it away is the flash this avoids.
    expect(resolveWelcomeRoute({ owned: undefined, claimed: false })).toEqual({
      action: "wait",
    });
  });

  test("stays put once a name has been claimed in this session", () => {
    // The whole reason `claimed` exists. Without it, finishing step 1 bounces
    // the user into a console with no bucket connected.
    expect(
      resolveWelcomeRoute({ owned: 1, claimed: true }),
    ).toEqual({ action: "render" });
  });

  test("a claim in flight outranks a standing that has not loaded", () => {
    expect(resolveWelcomeRoute({ owned: undefined, claimed: true })).toEqual({
      action: "render",
    });
  });
});
