/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * `InviteBody` and `InviteListBody` use no router. Their modules do — and
 * `expo-router` ships untranspiled JSX that this project's jest transform does
 * not reach into `node_modules` for. Stubbing the three names those modules
 * import is the whole of it; nothing below touches any of them.
 */
jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: () => {} }),
}));

import { InviteBody } from "../features/invite/InviteScreen";
import { InviteListBody } from "../features/invite/InviteListScreen";
import {
  resolveInviteListView,
  resolveInviteView,
  type InviteListView,
  type InviteView,
  type PendingInvitation,
} from "../features/invite/invite";

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The invitation screens, on the glass.
 *
 * `inviteState.test.ts` proves the rules. This proves the screens are wired to
 * them, which is a different failure and the one that actually ships: a body
 * that resolves four dead causes to one view and then renders a different
 * sentence for one of them would pass every assertion in that file.
 *
 * Three things are asserted here that no pure function can answer:
 *
 *  1. **Two different dead tokens produce byte-identical pages.** Not "both
 *     contain the headline" — the same `textContent`, in the same order. That
 *     is the same discipline the control plane's frozen link previews follow,
 *     and it is the only form of this assertion that survives somebody adding
 *     a helpful subtitle to one branch.
 *  2. **Accept and Decline are wired.** A screen that draws two buttons and
 *     calls nothing is the whole feature missing.
 *  3. **The empty list is not a dead end.** Somebody was sent to `/invite` by
 *     the app's own gate; a blank page there is the referral thrown away for
 *     the second time.
 *
 * `react-native-web` renders these components to real DOM (see
 * `jest.config.js`), so the text below is the real copy and the clicks below
 * are the clicks a person makes.
 */

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const AUTHED = { isLoading: false, isAuthenticated: true };
const IDLE = { kind: "idle" } as const;

function invitation(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    token: "tok_live",
    workspaceId: "ws_1",
    slug: "ignite",
    displayName: "Ignite Media",
    role: "member",
    invitedBy: "usr_deadbeefdeadbeef",
    createdAt: NOW - DAY,
    expiresAt: NOW + 6 * DAY,
    ...overrides,
  };
}

interface Screen {
  text: string;
  q: (testID: string) => HTMLElement | null;
  click: (testID: string) => void;
  unmount: () => void;
}

function mount(node: ReturnType<typeof createElement>): Screen {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  const q = (testID: string) =>
    container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
  return {
    text: container.textContent ?? "",
    q,
    click: (testID: string) => {
      const element = q(testID);
      if (element === null) throw new Error(`no control called ${testID}`);
      act(() => {
        element.click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function mountInvite(
  view: InviteView,
  onDecide: (choice: "accept" | "decline") => void = () => {},
  leave: { console?: () => void; welcome?: () => void } = {},
): Screen {
  return mount(
    createElement(InviteBody, {
      view,
      now: NOW,
      onDecide,
      onLeaveForConsole: leave.console ?? (() => {}),
      onLeaveForWelcome: leave.welcome ?? (() => {}),
    }),
  );
}

function mountList(
  view: InviteListView,
  onDecide: (token: string, choice: "accept" | "decline") => void = () => {},
  leave: { console?: () => void; welcome?: () => void } = {},
): Screen {
  return mount(
    createElement(InviteListBody, {
      view,
      now: NOW,
      onDecide,
      onLeaveForConsole: leave.console ?? (() => {}),
      onLeaveForWelcome: leave.welcome ?? (() => {}),
    }),
  );
}

describe("a dead token renders one page, whatever killed it", () => {
  /** Rendered text for each of the ways an invitation can be unusable. */
  const pages = [
    ["a token that was never issued", { token: "tok_guessed", invitations: [] }],
    [
      "a token that is not in this caller's list",
      { token: "tok_live", invitations: [invitation({ token: "tok_other" })] },
    ],
    [
      "a token that expired while the page sat open",
      { token: "tok_live", invitations: [invitation({ expiresAt: NOW - 1 })] },
    ],
    ["no token in the URL at all", { token: null, invitations: [] }],
  ] as const;

  const rendered = pages.map(([name, inputs]) => {
    const screen = mountInvite(
      resolveInviteView({ ...inputs, auth: AUTHED, decision: IDLE, now: NOW }),
    );
    const text = screen.text;
    screen.unmount();
    return [name, text] as const;
  });

  test("all four are the same page, character for character", () => {
    // Equality between the pages, not four separate "looks reasonable" checks.
    // A helpful subtitle added to one branch is exactly the regression this
    // catches, and it is the only shape of this assertion that does.
    for (const [name, text] of rendered) {
      expect([name, text]).toEqual([name, rendered[0]![1]]);
    }
  });

  test("and none of them offers to accept anything", () => {
    const screen = mountInvite(
      resolveInviteView({
        token: "tok_guessed",
        auth: AUTHED,
        invitations: [],
        decision: IDLE,
        now: NOW,
      }),
    );
    expect(screen.q("invite-accept")).toBeNull();
    expect(screen.q("invite-decline")).toBeNull();
    screen.unmount();
  });

  test("a failed subscription does not render as a dead token", () => {
    // Different cause, different sentence — and this one is safe to
    // distinguish, because the failure is in the query rather than in the
    // token. Saying "spent" here would be a lie about a link somebody cannot
    // get back.
    const screen = mountInvite(
      resolveInviteView({
        token: "tok_live",
        auth: AUTHED,
        invitations: new Error("socket closed"),
        decision: IDLE,
        now: NOW,
      }),
    );
    expect(screen.q("invite-unavailable")).not.toBeNull();
    expect(screen.text).not.toBe(rendered[0]![1]);
    screen.unmount();
  });

  test("every dead end offers two ways on, and both are wired", () => {
    const went: string[] = [];
    const screen = mountInvite(
      resolveInviteView({
        token: null,
        auth: AUTHED,
        invitations: [],
        decision: IDLE,
        now: NOW,
      }),
      () => {},
      { console: () => went.push("console"), welcome: () => went.push("welcome") },
    );
    screen.click("invite-welcome");
    screen.click("invite-console");
    // Both destinations resolve themselves for whatever this account has, so
    // neither button can strand anybody: `/console` sends an account with no
    // contexts to `/welcome`, and `/welcome` sends an owner to the console.
    expect(went).toEqual(["welcome", "console"]);
    screen.unmount();
  });
});

describe("the invitation itself", () => {
  const view = resolveInviteView({
    token: "tok_live",
    auth: AUTHED,
    invitations: [invitation()],
    decision: IDLE,
    now: NOW,
  });

  test("names the context, the role, and when the link runs out", () => {
    const screen = mountInvite(view);
    expect(screen.text).toContain("You've been invited to @ignite");
    expect(screen.text).toContain("Ignite Media (@ignite)");
    expect(screen.text).toContain("A member — can read notes.");
    expect(screen.text).toContain("expires in 6 days");
    screen.unmount();
  });

  test("never shows the opaque id of whoever sent it", () => {
    const screen = mountInvite(view);
    expect(screen.text).not.toContain("usr_deadbeefdeadbeef");
    expect(screen.text).not.toContain("ws_1");
    screen.unmount();
  });

  test("carries the overview, because this is where a stranger reads it", () => {
    const screen = mountInvite(view);
    expect(screen.q("context-overview")).not.toBeNull();
    expect(screen.text).toContain("One context, every client");
    // And the shared-buckets caveat travels with it, on the one screen where
    // somebody is being handed access to somebody else's context.
    expect(screen.text).toContain("coming soon");
    screen.unmount();
  });

  test("accept and decline both reach the handler", () => {
    const chose: string[] = [];
    const screen = mountInvite(view, (choice) => chose.push(choice));
    screen.click("invite-accept");
    screen.click("invite-decline");
    expect(chose).toEqual(["accept", "decline"]);
    screen.unmount();
  });

  test("while one is in flight neither can be pressed again", () => {
    const chose: string[] = [];
    const screen = mountInvite(
      resolveInviteView({
        token: "tok_live",
        auth: AUTHED,
        invitations: [invitation()],
        decision: { kind: "submitting", choice: "accept" },
        now: NOW,
      }),
      (choice) => chose.push(choice),
    );
    screen.click("invite-accept");
    screen.click("invite-decline");
    expect(chose).toEqual([]);
    expect(screen.text).toContain("Accepting…");
    screen.unmount();
  });

  test("declining says what happened rather than showing a broken link", () => {
    const screen = mountInvite(
      resolveInviteView({
        token: "tok_live",
        auth: AUTHED,
        // The row is already gone from the subscription — this is the state
        // that used to read as "this invitation link doesn't work".
        invitations: [],
        decision: { kind: "declined" },
        now: NOW,
      }),
    );
    expect(screen.q("invite-declined")).not.toBeNull();
    expect(screen.text).toContain("Declined");
    screen.unmount();
  });
});

describe("the bare /invite list", () => {
  test("shows every pending invitation with both answers", () => {
    const view = resolveInviteListView({
      auth: AUTHED,
      invitations: [
        invitation({ token: "a", slug: "ignite", createdAt: NOW - 3 * DAY }),
        invitation({ token: "b", slug: "public-worship", createdAt: NOW - DAY }),
      ],
      decision: IDLE,
      now: NOW,
    });
    const screen = mountList(view);
    for (const token of ["a", "b"]) {
      expect(screen.q(`invite-accept-${token}`)).not.toBeNull();
      expect(screen.q(`invite-decline-${token}`)).not.toBeNull();
    }
    expect(screen.text).toContain("@ignite");
    expect(screen.text).toContain("@public-worship");
    screen.unmount();
  });

  test("answering a row reaches the handler with that row's token", () => {
    const chose: Array<[string, string]> = [];
    const screen = mountList(
      resolveInviteListView({
        auth: AUTHED,
        invitations: [invitation({ token: "a" }), invitation({ token: "b" })],
        decision: IDLE,
        now: NOW,
      }),
      (token, choice) => chose.push([token, choice]),
    );
    screen.click("invite-accept-b");
    expect(chose).toEqual([["b", "accept"]]);
    screen.unmount();
  });

  test("one answer in flight locks every row, not just its own", () => {
    // Two mutations in flight would race one decision, and the second answer
    // would silently overwrite the first one's outcome — including a `joined`
    // that was already routing somebody into a context.
    const chose: Array<[string, string]> = [];
    const screen = mountList(
      resolveInviteListView({
        auth: AUTHED,
        invitations: [invitation({ token: "a" }), invitation({ token: "b" })],
        decision: { kind: "submitting", token: "b", choice: "accept" },
        now: NOW,
      }),
      (token, choice) => chose.push([token, choice]),
    );
    screen.click("invite-accept-a");
    screen.click("invite-decline-b");
    expect(chose).toEqual([]);
    screen.unmount();
  });

  test("an empty list is a screen with a way on, not a blank page", () => {
    const went: string[] = [];
    const screen = mountList(
      resolveInviteListView({ auth: AUTHED, invitations: [], decision: IDLE, now: NOW }),
      () => {},
      { console: () => went.push("console"), welcome: () => went.push("welcome") },
    );
    expect(screen.q("invite-list-empty")).not.toBeNull();
    expect(screen.text).toContain("Nothing to answer");
    // The state somebody lands in after answering the last invitation in
    // another tab. It has to say so and offer somewhere to go.
    screen.click("invite-welcome");
    screen.click("invite-console");
    expect(went).toEqual(["welcome", "console"]);
    screen.unmount();
  });

  test("an expired row is not offered a button that is certain to fail", () => {
    const screen = mountList(
      resolveInviteListView({
        auth: AUTHED,
        invitations: [invitation({ token: "a", expiresAt: NOW - 1 })],
        decision: IDLE,
        now: NOW,
      }),
    );
    expect(screen.q("invite-accept-a")).toBeNull();
    expect(screen.q("invite-list-empty")).not.toBeNull();
    screen.unmount();
  });
});
