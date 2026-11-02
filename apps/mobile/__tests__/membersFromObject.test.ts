/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { useMembers } from "../features/console/members/useMembers";
import type { MembersView } from "../features/console/members/members";
import { useObjectAccess } from "../features/access/useObjectAccess";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The members screen reads members and invitations from the workspace object
 * when it serves them, and from Convex otherwise; writes go through the object
 * when it serves the topic (`objectFirst`), else the Convex mutation. Invite
 * creation always stays in Convex.
 *
 * `useQueries` and `useMutation` are stubbed so the spec and the mutation calls
 * can be read directly; `useObjectAccess` is stubbed per topic; `objectFirst`
 * is the real one.
 */

const mockConvexMutations = {
  removeMember: jest.fn<(args: unknown) => Promise<unknown>>(async () => "convex-remove"),
  setMemberRole: jest.fn<(args: unknown) => Promise<unknown>>(async () => "convex-role"),
  revokeInvitation: jest.fn<(args: unknown) => Promise<unknown>>(async () => "convex-revoke"),
  inviteMember: jest.fn<(args: unknown) => Promise<unknown>>(async () => "convex-invite"),
};
const mockConvexQueryResults: Record<string, unknown> = {};
const mockLastSpec: { current: Record<string, { query: unknown; args: unknown }> | null } = { current: null };

// The factory is hoisted above the imports, so it reaches only `mock`-prefixed
// variables from this file, and gets `getFunctionName` from its own require.
jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server");
  return {
    useQueries: (spec: Record<string, { query: unknown; args: unknown }>) => {
      mockLastSpec.current = spec;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(spec)) out[key] = mockConvexQueryResults[key];
      return out;
    },
    useMutation: (ref: unknown) => {
      const name: string = getFunctionName(ref);
      if (name.endsWith(":removeMember")) return mockConvexMutations.removeMember;
      if (name.endsWith(":setMemberRole")) return mockConvexMutations.setMemberRole;
      if (name.endsWith(":revokeInvitation")) return mockConvexMutations.revokeInvitation;
      return mockConvexMutations.inviteMember;
    },
  };
});

jest.mock("../features/access/useObjectAccess", () => {
  const actual = jest.requireActual<typeof import("../features/access/useObjectAccess")>(
    "../features/access/useObjectAccess",
  );
  return { ...actual, useObjectAccess: jest.fn() };
});

const MEMBER_ROWS = [
  { userId: "u1", role: "owner", email: "a@example.test", name: "Ada", isMe: true, joinedAt: 1 },
  { userId: "u2", role: "member", email: "b@example.test", name: "Bo", isMe: false, joinedAt: 2 },
];
const INVITE_ROWS = [
  { invitationId: "i1", invitee: "c@example.test", role: "member", invitedBy: "u1", createdAt: 3, expiresAt: 9 },
];

type Topic = { served: boolean; rows: unknown; run: jest.Mock<(op: string, args?: unknown) => Promise<unknown>> };

function topic(served: boolean, rows: unknown): Topic {
  return { served, rows, run: jest.fn(async () => "object-result") };
}

const mockedUseObjectAccess = useObjectAccess as unknown as jest.Mock<(...args: unknown[]) => Topic>;

function setObjects(members: Topic, invites: Topic) {
  mockedUseObjectAccess.mockImplementation((_side: unknown, _ws: unknown, name: unknown) =>
    name === "members" ? members : invites,
  );
}

function mount(): MembersView {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let view: MembersView | null = null;
  function Probe() {
    view = useMembers({ workspaceId: "w1" as never, role: "owner" });
    return null;
  }
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  act(() => root.unmount());
  container.remove();
  if (view === null) throw new Error("the hook did not render");
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockConvexQueryResults)) delete mockConvexQueryResults[key];
  mockLastSpec.current = null;
});

describe("members and invitations come from the workspace object when it serves them", () => {
  test("served: the rows are the object's and Convex is not asked for either topic", () => {
    setObjects(topic(true, MEMBER_ROWS), topic(true, INVITE_ROWS));
    mockConvexQueryResults.members = "convex-members-should-not-show";
    mockConvexQueryResults.invitations = "convex-invites-should-not-show";

    const view = mount();

    expect(mockLastSpec.current).toEqual({});
    expect(view.loading).toBe(false);
    expect(view.failure).toBeNull();
    expect(view.members.map((m) => m.userId)).toEqual(["u1", "u2"]);
    expect(view.members[0]).toMatchObject({ name: "Ada", email: "a@example.test", isMe: true, joinedAt: 1 });
    expect(view.invitations).toEqual([
      { invitationId: "i1", invitee: "c@example.test", role: "member", expiresAt: 9 },
    ]);
  });

  test("served members only: listMembers is skipped, listInvitations is still asked", () => {
    setObjects(topic(true, MEMBER_ROWS), topic(false, undefined));
    mockConvexQueryResults.invitations = INVITE_ROWS;

    const view = mount();
    const keys = Object.keys(mockLastSpec.current ?? {});

    expect(keys).toEqual(["invitations"]);
    expect(getFunctionName(mockLastSpec.current!.invitations.query as never)).toMatch(/listInvitations$/);
    expect(view.members.map((m) => m.userId)).toEqual(["u1", "u2"]);
    expect(view.invitations).toHaveLength(1);
  });

  test("not served: Convex rows are used and both queries are asked", () => {
    setObjects(topic(false, undefined), topic(false, undefined));
    mockConvexQueryResults.members = MEMBER_ROWS;
    mockConvexQueryResults.invitations = INVITE_ROWS;

    const view = mount();
    const keys = Object.keys(mockLastSpec.current ?? {}).sort();

    expect(keys).toEqual(["invitations", "members"]);
    expect(getFunctionName(mockLastSpec.current!.members.query as never)).toMatch(/listMembers$/);
    expect(view.members.map((m) => m.userId)).toEqual(["u1", "u2"]);
    expect(view.invitations.map((i) => i.invitationId)).toEqual(["i1"]);
  });

  test("not served and Convex still loading: the card is loading, not empty-and-done", () => {
    setObjects(topic(false, undefined), topic(false, undefined));
    const view = mount();
    expect(view.loading).toBe(true);
    expect(view.members).toEqual([]);
  });

  test("a failed Convex listMembers is a failure only when the object does not serve it", () => {
    setObjects(topic(false, undefined), topic(false, undefined));
    mockConvexQueryResults.members = new Error("boom");
    mockConvexQueryResults.invitations = [];
    expect(mount().failure).not.toBeNull();

    setObjects(topic(true, MEMBER_ROWS), topic(false, undefined));
    mockConvexQueryResults.members = new Error("boom");
    expect(mount().failure).toBeNull();
  });
});

describe("writes go through the object when it serves the topic", () => {
  test("served: removing a member runs remove_member on the object, not the Convex mutation", async () => {
    const members = topic(true, MEMBER_ROWS);
    setObjects(members, topic(true, INVITE_ROWS));
    const view = mount();

    await view.actions!.remove("u2");

    expect(members.run).toHaveBeenCalledWith("remove_member", { userId: "u2" });
    expect(mockConvexMutations.removeMember).not.toHaveBeenCalled();
  });

  test("not served: removing a member calls the Convex mutation", async () => {
    setObjects(topic(false, undefined), topic(false, undefined));
    mockConvexQueryResults.members = MEMBER_ROWS;
    mockConvexQueryResults.invitations = INVITE_ROWS;
    const view = mount();

    await view.actions!.remove("u2");

    expect(mockConvexMutations.removeMember).toHaveBeenCalledWith({ workspaceId: "w1", userId: "u2" });
  });

  test("served: a role change and a revoke go to the object; invite stays in Convex", async () => {
    const members = topic(true, MEMBER_ROWS);
    const invites = topic(true, INVITE_ROWS);
    setObjects(members, invites);
    const view = mount();

    await view.actions!.setRole("u2", "member" as never);
    await view.actions!.withdraw("i1");
    await view.actions!.invite("d@example.test", "member" as never);

    expect(members.run).toHaveBeenCalledWith("set_role", { userId: "u2", role: "member" });
    expect(invites.run).toHaveBeenCalledWith("revoke_invite", { invitationId: "i1" });
    expect(mockConvexMutations.setMemberRole).not.toHaveBeenCalled();
    expect(mockConvexMutations.revokeInvitation).not.toHaveBeenCalled();
    expect(mockConvexMutations.inviteMember).toHaveBeenCalledTimes(1);
  });

  test("a refusal from the object other than not_served is thrown, not retried in Convex", async () => {
    const members = topic(true, MEMBER_ROWS);
    members.run.mockImplementation(async () => {
      const { AccessRefusal } = jest.requireActual<typeof import("../features/access/objectAccess")>(
        "../features/access/objectAccess",
      );
      throw new AccessRefusal("forbidden");
    });
    setObjects(members, topic(false, undefined));
    const view = mount();

    await expect(view.actions!.remove("u2")).rejects.toThrow("forbidden");
    expect(mockConvexMutations.removeMember).not.toHaveBeenCalled();
  });
});
