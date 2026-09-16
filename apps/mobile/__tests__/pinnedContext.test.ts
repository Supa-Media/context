import { describe, expect, test } from "@jest/globals";
import { contextMenuItems } from "../features/console/contextMenu";
import { defaultContext, landingHref } from "../features/console/nav";
import { pinnedContext, railGroup } from "../features/console/rail";
import { stripOrder } from "../features/console/strip";
import type { ConsoleContext } from "../features/console/types";
import {
  needsOnboarding,
  offerOwnContext,
  ownedContexts,
  standingFrom,
} from "../features/onboarding/route";

/**
 * THE PINNED CONTEXT, on the surfaces that draw it — `@context-lc`, which the
 * control plane puts in every account's list whether or not they were invited.
 *
 * Every rule here exists because a row that is in the list and is *not this
 * person's* breaks something that was correct while every row was theirs. The
 * file is grouped by what breaks, not by which module holds the fix, because
 * two of these are the same mistake in two places.
 *
 * ## The one that is not cosmetic
 *
 * `needsOnboarding` asks "is there anything here for you" by counting
 * `listMyWorkspaces`. The moment the control plane started appending a row for
 * everybody, that count was never zero — so a brand-new account rendered the
 * console instead of redirecting to `/welcome`, never claimed a name, never
 * connected a bucket, and had no route to either. Somewhere to read our docs is
 * not somewhere to go instead of onboarding, and the first block below is that
 * claim under test from both ends.
 *
 * ## The two that are ordering
 *
 * The rail separates the pinned row with a hairline above it and the strip with
 * a divider before it, and both of those are *positional* claims: "everything
 * after this is different" is only true while exactly one row follows. So both
 * orderings pin it last rather than trusting the order the control plane sent,
 * and both are tested against a list that arrives in the wrong order on purpose.
 *
 * ## The two that are "a control that would fail"
 *
 * Landing in it, and the menu on it. Neither is tidiness: `defaultContext`'s
 * fallback picks the first row for somebody who owns nothing, which is exactly
 * the person the pin is most visible to; and three of the four menu items are
 * backed by queries that answer `WORKSPACE_NOT_FOUND` for a pinned reader.
 */

/** A console row. `pinned` is the only field most of these tests vary. */
function context(over: Partial<ConsoleContext> & { slug: string }): ConsoleContext {
  return {
    id: over.slug,
    displayName: over.slug,
    role: "owner",
    kind: "personal",
    status: "ok",
    ...over,
  };
}

/** The pinned row as the control plane sends it: shared, member, flagged. */
const PINNED = context({
  slug: "context-lc",
  kind: "shared",
  role: "member",
  pinned: true,
});

/* -------------------------------------------------------------------------- */
/*                onboarding: the pin is not a context you have                */
/* -------------------------------------------------------------------------- */

describe("onboarding does not count the pinned context", () => {
  test("an account with only the pin is standing on nothing", () => {
    expect(standingFrom([{ kind: "shared", role: "member", pinned: true }], [])).toEqual(
      { owned: 0, reachable: 0, invitations: 0 },
    );
  });

  test("so it is sent to /welcome rather than into the console", () => {
    const standing = standingFrom(
      [{ kind: "shared", role: "member", pinned: true }],
      [],
    );
    expect(needsOnboarding({ standing, pathname: "/console" })).toEqual({
      action: "redirect",
      href: "/welcome",
    });
  });

  test("a pending invitation still wins over the pin", () => {
    // The pin must not make an invitee look settled either: they have nothing,
    // and the invitation is the reason they opened the app.
    const standing = standingFrom(
      [{ kind: "shared", role: "member", pinned: true }],
      [{}],
    );
    expect(needsOnboarding({ standing, pathname: "/console" })).toEqual({
      action: "redirect",
      href: "/invite",
    });
  });

  test("a real context alongside the pin is still a reason to render", () => {
    const standing = standingFrom(
      [
        { kind: "personal", role: "owner" },
        { kind: "shared", role: "member", pinned: true },
      ],
      [],
    );
    expect(standing).toEqual({ owned: 1, reachable: 1, invitations: 0 });
    expect(needsOnboarding({ standing, pathname: "/console" })).toEqual({
      action: "render",
    });
  });

  /**
   * The failure path this module already had, now with a pinned row in it.
   *
   * When the invitation query has not answered, `standingFrom` waits — unless
   * the person can reach nothing, in which case it answers rather than leaving
   * them in an empty console forever. A pinned row made "can reach nothing"
   * false, which turned that escape hatch off for exactly the account it was
   * written for.
   */
  test("the invitation query failing does not strand a fresh account", () => {
    expect(
      standingFrom([{ kind: "shared", role: "member", pinned: true }], undefined),
    ).toEqual({ owned: 0, reachable: 0, invitations: 0 });
  });

  test("the pin is not a context you own", () => {
    expect(ownedContexts([{ kind: "shared", role: "member", pinned: true }])).toBe(0);
  });

  test("so the console still offers to make them one", () => {
    expect(
      offerOwnContext({
        contexts: [{ kind: "shared", role: "member", pinned: true }],
        loading: false,
      }),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                         the rail: last, under a rule                        */
/* -------------------------------------------------------------------------- */

describe("the rail draws the pinned context apart", () => {
  const own = context({ slug: "sayo" });
  const shared = context({ slug: "acme", kind: "shared", role: "editor" });

  test("it is last, whatever order it arrived in", () => {
    const group = railGroup({
      // Deliberately first, which is where a `createdAt` sort would put it: the
      // workspace is older than almost every account that will see it.
      contexts: [PINNED, shared, own],
      claimable: false,
    });
    expect(group.contexts.map((c) => c.slug)).toEqual(["sayo", "acme", "context-lc"]);
  });

  test("the person's own workspace still leads", () => {
    const group = railGroup({ contexts: [shared, PINNED, own], claimable: false });
    expect(group.contexts[0]!.slug).toBe("sayo");
  });

  test("the order in between is still the control plane's", () => {
    const other = context({ slug: "publicworship", kind: "shared", role: "member" });
    const group = railGroup({
      contexts: [shared, other, PINNED, own],
      claimable: false,
    });
    expect(group.contexts.map((c) => c.slug)).toEqual([
      "sayo",
      "acme",
      "publicworship",
      "context-lc",
    ]);
  });

  test("the group names it, so the rail need not re-find it", () => {
    expect(railGroup({ contexts: [own, PINNED], claimable: false }).pinned).toBe(PINNED);
    expect(railGroup({ contexts: [own], claimable: false }).pinned).toBeNull();
  });

  test("it is found by the flag and never by the name", () => {
    // A row with the same slug and no flag is an ordinary context — somebody
    // who really is a member of it, whose real role the control plane sent.
    const asMember = context({
      slug: "context-lc",
      kind: "shared",
      role: "editor",
    });
    expect(pinnedContext([own, asMember])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                        the strip: last, after a divider                     */
/* -------------------------------------------------------------------------- */

describe("the phone strip keeps the pinned pill last", () => {
  const own = context({ slug: "sayo" });
  const shared = context({ slug: "acme", kind: "shared", role: "editor" });

  test("recency does not move it", () => {
    // The strongest case: it is the most recently visited context, so every
    // other rule in `stripOrder` wants it first.
    const ordered = stripOrder([own, shared, PINNED], null, [
      { slug: "context-lc" },
      { slug: "acme" },
    ]);
    expect(ordered.map((c) => c.slug)).toEqual(["acme", "sayo", "context-lc"]);
  });

  test("the divider has exactly one pill after it", () => {
    const ordered = stripOrder([PINNED, own, shared], null, []);
    // The divider is drawn immediately before the flagged pill, so this is the
    // property that makes it mean "everything after this is different".
    expect(ordered.findIndex((c) => c.pinned === true)).toBe(ordered.length - 1);
  });

  test("a strip with no pinned context is untouched", () => {
    const ordered = stripOrder([own, shared], null, [{ slug: "acme" }]);
    expect(ordered.map((c) => c.slug)).toEqual(["acme", "sayo"]);
  });

  test("the context being read is still drawn in the breadcrumb, not here", () => {
    const ordered = stripOrder([own, PINNED], "context-lc", []);
    expect(ordered.map((c) => c.slug)).toEqual(["sayo"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     landing: never into somebody else's docs                */
/* -------------------------------------------------------------------------- */

describe("nobody lands in the pinned context", () => {
  test("not even somebody who owns nothing else", () => {
    // The fallback's own case, and the one the pin broke: `?? contexts[0]`
    // exists for a person with no owned context, which is precisely who signs
    // in with the pin as their only row.
    expect(defaultContext([{ role: "member", pinned: true }])).toBeNull();
  });

  test("a context they own still wins", () => {
    expect(
      defaultContext([
        { role: "member", pinned: true },
        { role: "owner" },
      ]),
    ).toEqual({ role: "owner" });
  });

  test("and so does one they were merely invited into", () => {
    expect(
      defaultContext([
        { role: "member", pinned: true },
        { role: "member" },
      ]),
    ).toEqual({ role: "member" });
  });

  test("/console does not redirect into it", () => {
    expect(landingHref([{ slug: "context-lc", role: "member", pinned: true }])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                          the menu: Open, and nothing                        */
/* -------------------------------------------------------------------------- */

describe("the pinned context's menu", () => {
  test("offers Open and nothing else", () => {
    expect(contextMenuItems("context-lc", { pinned: true }).map((i) => i.key)).toEqual([
      "open",
    ]);
  });

  test("Leave is gone even though the role would otherwise offer it", () => {
    // `canLeave` is true for any non-owner, and a pinned row is `member` — so
    // this is the combination the flag exists to break, not a case it never
    // meets.
    expect(
      contextMenuItems("context-lc", { pinned: true, canLeave: true }).map((i) => i.key),
    ).toEqual(["open"]);
  });

  test("an ordinary context somebody is a member of is unchanged", () => {
    expect(contextMenuItems("acme", { canLeave: true }).map((i) => i.key)).toEqual([
      "open",
      "settings",
      "sharing",
      "leave",
    ]);
  });
});
