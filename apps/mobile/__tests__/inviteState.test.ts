import { describe, expect, test } from "@jest/globals";
import {
  INVITATION_DEAD,
  acceptanceLine,
  contextLabel,
  describeInviteFailure,
  findInvitation,
  firstParam,
  invitationLede,
  invitationTerms,
  invitationTitle,
  resolveInviteListView,
  resolveInviteView,
  signInHref,
  stillPending,
  type InviteListView,
  type InviteView,
  type PendingInvitation,
} from "../features/invite/invite";

/**
 * The invitation flow's rules, without a renderer.
 *
 * Three classes of bug live here, and every one of them is invisible to a
 * person clicking through the happy path.
 *
 *  1. **A redirect that drops what the URL was carrying.** An invitation token
 *     exists in one email and nowhere else — no rail entry reproduces it — so a
 *     signed-out visitor sent to a bare `/login` has lost the invitation, and
 *     will discover that only after signing in. This is the same defect
 *     `/authorize` was built to avoid, and it looks fine every time you test it
 *     while already signed in.
 *
 *  2. **Copy that un-collapses what the backend deliberately collapsed.**
 *     `acceptInvitation` throws one `INVITATION_NOT_FOUND` for "no such
 *     invitation", "not yours", "already answered" and "expired", because a
 *     token is the only handle on an invitation and any difference between
 *     those confirms a guess. A screen that says "this one expired" for one of
 *     them and "we don't know that link" for another hands the oracle back
 *     through the interface. So the assertions below are equalities *between*
 *     the four causes, not just checks that each says something reasonable.
 *
 *  3. **A state that answers a stale list.** Accepting and declining both spend
 *     the invitation, so the row leaves `listMyInvitations` a moment later. A
 *     resolver that reads the list first tells the person who just declined
 *     that their link was never valid.
 */

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const AUTHED = { isLoading: false, isAuthenticated: true };
const SIGNED_OUT = { isLoading: false, isAuthenticated: false };
const RESOLVING = { isLoading: true, isAuthenticated: false };

const IDLE = { kind: "idle" } as const;

function invitation(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    token: "tok_live",
    workspaceId: "ws_1",
    slug: "ignite",
    displayName: "Ignite",
    role: "member",
    invitedBy: "usr_0000000000000000",
    createdAt: NOW - DAY,
    expiresAt: NOW + 6 * DAY,
    ...overrides,
  };
}

/** A `ConvexError` as the client sees it: a code on `.data`. */
function thrown(code: string): unknown {
  return { data: { code, message: "…" } };
}

describe("a signed-out visitor keeps the invitation they were sent", () => {
  test("the token rides along in `next`, encoded, so sign-in comes back to it", () => {
    const view = resolveInviteView({
      token: "tok_live",
      auth: SIGNED_OUT,
      invitations: undefined,
      decision: IDLE,
      now: NOW,
    });
    // The whole point: `/login` on its own would strand them, because there is
    // no other way back to this token.
    expect(view).toEqual({ kind: "signIn", href: "/login?next=%2Finvite%2Ftok_live" });
  });

  test("the target decodes back to the invitation route, not to somewhere else", () => {
    // `loginHref` narrows through `safeNextRoute`, so a target that would leave
    // the app never survives being built. Decoding it here proves the token is
    // still in one piece after that narrowing and the encode.
    const href = signInHref("tok_live");
    const next = decodeURIComponent(href.slice("/login?next=".length));
    expect(next).toBe("/invite/tok_live");
  });

  test("a token with URL-significant characters survives the round trip", () => {
    const next = decodeURIComponent(signInHref("a/b?c=d").slice("/login?next=".length));
    // Encoded twice on the way out — once into the path segment, once into the
    // query parameter — so one decode leaves the segment escaped rather than
    // opening a second path or a second parameter.
    expect(next).toBe("/invite/a%2Fb%3Fc%3Dd");
  });

  test("the bare list has nothing to carry and asks for nothing", () => {
    expect(signInHref(null)).toBe("/login?next=%2Finvite");
    expect(
      resolveInviteListView({
        auth: SIGNED_OUT,
        invitations: undefined,
        decision: IDLE,
        now: NOW,
      }),
    ).toEqual({ kind: "signIn", href: "/login?next=%2Finvite" });
  });

  test("auth that has not resolved renders nothing rather than guessing", () => {
    // Deciding here is how somebody signed in gets a flash of the sign-in
    // screen — and, worse, a `next` written from a session that did exist.
    const inputs = { invitations: undefined, decision: IDLE, now: NOW } as const;
    expect(resolveInviteView({ token: "tok_live", auth: RESOLVING, ...inputs })).toEqual({
      kind: "wait",
    });
    expect(resolveInviteListView({ auth: RESOLVING, ...inputs })).toEqual({ kind: "wait" });
  });
});

describe("every dead token is the same dead token", () => {
  /** The four ways an invitation can be unusable, each resolved to a view. */
  const causes: Record<string, InviteView> = {
    "never issued": resolveInviteView({
      token: "tok_guessed",
      auth: AUTHED,
      invitations: [],
      decision: IDLE,
      now: NOW,
    }),
    "addressed to somebody else, or already answered": resolveInviteView({
      // Both reach the screen the same way: the row is not in *this* caller's
      // pending list. There is no query that would say more, and there must
      // not be one.
      token: "tok_live",
      auth: AUTHED,
      invitations: [invitation({ token: "tok_other" })],
      decision: IDLE,
      now: NOW,
    }),
    "expired while the page sat open": resolveInviteView({
      token: "tok_live",
      auth: AUTHED,
      invitations: [invitation({ expiresAt: NOW - 1 })],
      decision: IDLE,
      now: NOW,
    }),
    "no token in the URL at all": resolveInviteView({
      token: null,
      auth: AUTHED,
      invitations: [],
      decision: IDLE,
      now: NOW,
    }),
  };

  test("all four resolve to one view, field for field", () => {
    const views = Object.values(causes);
    for (const view of views) {
      expect(view).toEqual(views[0]);
    }
  });

  test("and that view is the one frozen message", () => {
    expect(causes["never issued"]).toEqual({
      kind: "dead",
      headline: INVITATION_DEAD.headline,
      detail: INVITATION_DEAD.detail,
    });
  });

  test("the message names the class of link, never this link", () => {
    const said = `${INVITATION_DEAD.headline} ${INVITATION_DEAD.detail}`.toLowerCase();
    // Each of these would answer a question the backend refuses to answer:
    // which of the four happened, and therefore whether a guessed token is real.
    expect(said).not.toMatch(/already (accepted|declined|answered|used)/);
    expect(said).not.toMatch(/this (link|invitation) (has )?expired/);
    expect(said).not.toMatch(/somebody else|someone else|not yours|not for you/);
    expect(said).not.toMatch(/no such|never existed|unknown/);
  });

  test("a refusal thrown mid-press reads exactly like a token that was never in the list", () => {
    // An invitation can expire between the render and the press. If that
    // produced different copy, the difference would be observable by anybody
    // willing to wait, which is no protection at all.
    for (const choice of ["accept", "decline"] as const) {
      expect(describeInviteFailure(thrown("INVITATION_NOT_FOUND"), choice)).toEqual({
        headline: INVITATION_DEAD.headline,
        next: INVITATION_DEAD.detail,
      });
    }
  });

  test("an unrecognised failure says nothing about the token", () => {
    const failure = describeInviteFailure(new Error("ECONNRESET"), "accept");
    expect(failure.headline).toBe("Couldn't accept this invitation");
    // Never the raw thrown text: that is whatever the runtime produced, and it
    // is how a stack trace ends up in a screenshot.
    expect(`${failure.headline} ${failure.next}`).not.toMatch(/ECONNRESET/);
  });
});

describe("a subscription that failed is not a verdict on the invitation", () => {
  test("an errored list is `unavailable`, not `dead`", () => {
    // The distinction the disclosure argument does not reach: a query failure
    // says nothing about the token, and telling somebody their emailed link is
    // spent when it is not is a mistake they cannot undo.
    const view = resolveInviteView({
      token: "tok_live",
      auth: AUTHED,
      invitations: new Error("socket closed"),
      decision: IDLE,
      now: NOW,
    });
    expect(view).toEqual({ kind: "unavailable" });
  });

  test("a list still in flight is `loading`, not empty", () => {
    expect(
      resolveInviteListView({
        auth: AUTHED,
        invitations: undefined,
        decision: IDLE,
        now: NOW,
      }),
    ).toEqual({ kind: "loading" });
  });
});

describe("accepting lands in the context that was joined", () => {
  test("the joined view carries the console URL for the slug the backend returned", () => {
    expect(
      resolveInviteView({
        token: "tok_live",
        auth: AUTHED,
        invitations: [invitation()],
        decision: { kind: "accepted", slug: "ignite" },
        now: NOW,
      }),
    ).toEqual({ kind: "joined", slug: "ignite", href: "/console/@ignite" });
  });

  test("it outranks the list, which no longer holds the row it just spent", () => {
    // Accepting removes the invitation from `listMyInvitations`. Reading the
    // list first would replace "you're in" with "this link doesn't work" at the
    // exact moment it worked.
    for (const invitations of [[], new Error("gone"), undefined] as const) {
      expect(
        resolveInviteView({
          token: "tok_live",
          auth: AUTHED,
          invitations,
          decision: { kind: "accepted", slug: "ignite" },
          now: NOW,
        }),
      ).toEqual({ kind: "joined", slug: "ignite", href: "/console/@ignite" });
    }
  });

  test("the list screen routes to the joined context the same way", () => {
    expect(
      resolveInviteListView({
        auth: AUTHED,
        invitations: [],
        decision: { kind: "accepted", slug: "public-worship" },
        now: NOW,
      }),
    ).toEqual({ kind: "joined", slug: "public-worship", href: "/console/@public-worship" });
  });
});

describe("declining is an answer, not a broken link", () => {
  test("the declined view survives the row leaving the list", () => {
    expect(
      resolveInviteView({
        token: "tok_live",
        auth: AUTHED,
        invitations: [],
        decision: { kind: "declined" },
        now: NOW,
      }),
    ).toEqual({ kind: "declined" });
  });
});

describe("the bare list", () => {
  test("an empty list is a screen of its own, not a list with no rows", () => {
    // `needsOnboarding` sends an account with no contexts and one pending
    // invitation here. Arriving to a blank page is the failure this view name
    // exists to prevent.
    expect(
      resolveInviteListView({ auth: AUTHED, invitations: [], decision: IDLE, now: NOW }),
    ).toEqual({ kind: "empty" });
  });

  test("a list whose only row has expired is empty, not a row that cannot be accepted", () => {
    const view = resolveInviteListView({
      auth: AUTHED,
      invitations: [invitation({ expiresAt: NOW - 1 })],
      decision: IDLE,
      now: NOW,
    });
    expect(view).toEqual({ kind: "empty" });
  });

  test("rows come back oldest first, so the order does not shuffle between renders", () => {
    const view = resolveInviteListView({
      auth: AUTHED,
      invitations: [
        invitation({ token: "b", createdAt: NOW - 1 * DAY }),
        invitation({ token: "a", createdAt: NOW - 3 * DAY }),
      ],
      decision: IDLE,
      now: NOW,
    }) as Extract<InviteListView, { kind: "list" }>;
    expect(view.invitations.map((row) => row.token)).toEqual(["a", "b"]);
  });

  test("answering one row marks that row busy and nothing else", () => {
    const view = resolveInviteListView({
      auth: AUTHED,
      invitations: [invitation({ token: "a" }), invitation({ token: "b" })],
      decision: { kind: "submitting", token: "b", choice: "accept" },
      now: NOW,
    }) as Extract<InviteListView, { kind: "list" }>;
    expect(view.busy).toEqual({ token: "b", choice: "accept" });
  });

  test("sorting does not mutate the array the subscription handed over", () => {
    // The rows come straight off a Convex subscription; sorting them in place
    // would reorder the value React is comparing against.
    const rows = [
      invitation({ token: "b", createdAt: NOW - 1 * DAY }),
      invitation({ token: "a", createdAt: NOW - 3 * DAY }),
    ];
    stillPending(rows, NOW);
    expect(rows.map((row) => row.token)).toEqual(["b", "a"]);
  });
});

describe("reading the token out of the URL", () => {
  test("a duplicated segment arrives as an array and the first one wins", () => {
    // Expo Router hands back `string | string[]`. Assuming a bare string is how
    // this becomes a crash on a URL somebody hand-edited.
    expect(firstParam(["tok_live", "tok_other"])).toBe("tok_live");
  });

  test("absent and empty are both `null`, which is the dead-token path", () => {
    expect(firstParam(undefined)).toBeNull();
    expect(firstParam("")).toBeNull();
    expect(firstParam([])).toBeNull();
  });

  test("a real token is returned untouched", () => {
    expect(firstParam("tok_live")).toBe("tok_live");
  });
});

describe("what the screen says an invitation is", () => {
  test("the title names the context by its handle", () => {
    expect(invitationTitle(invitation())).toBe("You've been invited to @ignite");
  });

  test("a display name that only repeats the slug is not said twice", () => {
    expect(contextLabel(invitation({ slug: "ignite", displayName: "Ignite" }))).toBe("@ignite");
    expect(contextLabel(invitation({ displayName: "Ignite Media" }))).toBe(
      "Ignite Media (@ignite)",
    );
    expect(contextLabel(invitation({ displayName: "  " }))).toBe("@ignite");
  });

  test("the role sentence is built from the members list's own vocabulary", () => {
    // Shared with `describeRole`, so the invitation and the members section
    // cannot drift into disagreeing about what an editor is allowed to do.
    expect(acceptanceLine("member")).toBe("A member — can read notes.");
    expect(acceptanceLine("editor")).toBe("An editor — can read and write notes.");
  });

  test("the terms say the link runs out, in the same words the owner sees", () => {
    expect(invitationTerms(invitation({ expiresAt: NOW + 6 * DAY }), NOW)).toBe(
      "Single-use, and only you can use it. This one expires in 6 days.",
    );
    expect(invitationTerms(invitation({ expiresAt: NOW + 2 * 60 * 60 * 1000 }), NOW)).toBe(
      "Single-use, and only you can use it. This one expires today.",
    );
  });

  test("nothing rendered contains the raw user id of whoever invited them", () => {
    // `listMyInvitations` returns `invitedBy` as an opaque id with no name
    // attached. Printing it tells the reader nothing and looks like a bug —
    // the rule `memberLabel` already follows — so the copy names the context.
    const row = invitation({ invitedBy: "usr_deadbeefdeadbeef" });
    const said = [
      invitationTitle(row),
      invitationLede(row),
      contextLabel(row),
      acceptanceLine(row.role),
      invitationTerms(row, NOW),
    ].join(" ");
    expect(said).not.toContain(row.invitedBy);
    expect(said).not.toContain(row.workspaceId);
  });
});

describe("looking a token up in your own pending list", () => {
  test("finds a live one", () => {
    expect(findInvitation([invitation()], "tok_live", NOW)?.slug).toBe("ignite");
  });

  test("refuses an expired one, so no button is offered that is certain to fail", () => {
    expect(findInvitation([invitation({ expiresAt: NOW })], "tok_live", NOW)).toBeNull();
  });

  test("refuses a token that is simply not there", () => {
    expect(findInvitation([invitation()], "tok_other", NOW)).toBeNull();
  });
});
