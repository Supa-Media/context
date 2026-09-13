import { describe, expect, test } from "@jest/globals";
import { isOwnWorkspace, ownWorkspace, railGroup } from "../features/console/rail";
import type { ConsoleContext } from "../features/console/types";

/**
 * The rail's **one list**: every context a person can reach under a single
 * heading, their own personal workspace pinned to the top of it, ownership a
 * mark on that one row, and the claim entry standing in the pinned slot when
 * there is nothing to pin there.
 *
 * This replaces the two headed groups — BRAINS and WORKSPACES — that the
 * retired vocabulary needed. A brain was only ever a workspace one person
 * owns, so the split was drawing a line the product no longer draws; see
 * `docs/decisions/vocabulary-and-workspaces.md` (2026-09-13).
 */

function context(overrides: Partial<ConsoleContext>): ConsoleContext {
  return {
    id: "w1",
    slug: "seyi",
    displayName: "seyi",
    role: "owner",
    kind: "personal",
    status: "ok",
    ...overrides,
  };
}

const own = context({ id: "own", slug: "seyi", role: "owner", kind: "personal" });
const ownShared = context({ id: "team", slug: "acme-eng", role: "owner", kind: "shared" });
const guestPersonal = context({ id: "sayo", slug: "sayo", role: "member", kind: "personal" });
const guestShared = context({ id: "pw", slug: "public-worship", role: "editor", kind: "shared" });

describe("railGroup", () => {
  /**
   * The change of shape itself. Personal and shared contexts are one kind of
   * thing to a person choosing where to go, and `kind` decides the pin rather
   * than a section boundary.
   */
  test("puts every reachable context in one list under one heading", () => {
    const group = railGroup({
      contexts: [own, guestPersonal, ownShared, guestShared],
      claimable: false,
    });

    expect(group.heading).toBe("Workspaces");
    expect(group.contexts.map((c) => c.id)).toEqual(["own", "sayo", "team", "pw"]);
  });

  /**
   * The retired noun must not come back through a heading, an empty state or
   * any other string this function hands the renderer. A guard nobody has
   * checked is not a guard — `docs/decisions/testing.md`.
   */
  test("says nothing about brains", () => {
    const group = railGroup({ contexts: [own, guestShared], claimable: true, creatable: true });
    expect(JSON.stringify(group)).not.toMatch(/brain/i);
  });

  /**
   * The pin that replaces the old section boundary. Your own workspace is the
   * row you reach for most and the one the "yours" mark is on, so it leads the
   * list whatever order the control plane sent — and whatever order anything
   * downstream would otherwise sort it into.
   */
  test("pins your own personal workspace to the top, whatever order it arrived in", () => {
    const group = railGroup({
      contexts: [guestShared, guestPersonal, ownShared, own],
      claimable: false,
    });
    expect(group.contexts.map((c) => c.id)).toEqual(["own", "pw", "sayo", "team"]);
  });

  /**
   * A pin, not a sort: everything after the pinned row keeps the order it
   * arrived in. Re-ordering somebody's list on their behalf is a decision the
   * rail is not making, and a stable list is what makes muscle memory work.
   */
  test("everything else keeps the order it arrived in", () => {
    const b = context({ id: "b", slug: "bee", role: "member", kind: "personal" });
    const a = context({ id: "a", slug: "ay", role: "member", kind: "shared" });
    const group = railGroup({ contexts: [b, a, own], claimable: false });
    expect(group.contexts.map((c) => c.id)).toEqual(["own", "b", "a"]);
  });

  /**
   * Somebody invited into other people's contexts and owning none. There is
   * no second group for them to be missing, and no pinned row — the list is
   * just the contexts, in the order they came.
   */
  test("a person who owns no personal workspace still gets the one list", () => {
    const group = railGroup({ contexts: [ownShared, guestShared, guestPersonal], claimable: false });
    expect(group.heading).toBe("Workspaces");
    expect(group.contexts.map((c) => c.id)).toEqual(["team", "pw", "sayo"]);
  });

  /**
   * The group is not conditional any more, because there is nothing for its
   * absence to say: it is the only group, and an account with nothing at all
   * needs it to hold "Nothing here yet".
   */
  test("an account with nothing at all keeps the group, for its empty state", () => {
    const group = railGroup({ contexts: [], claimable: false });
    expect(group.heading).toBe("Workspaces");
    expect(group.contexts).toEqual([]);
    expect(group.claim).toBe(false);
    expect(group.create).toBe(false);
  });
});

/**
 * Where ownership lives now that it is not a section.
 *
 * Both halves of `isOwnWorkspace` are required and neither is sufficient —
 * which is the whole reason a single-axis grouping could not express it.
 */
describe("the own-workspace mark", () => {
  test("needs a personal context you own, and nothing else qualifies", () => {
    expect(isOwnWorkspace(own)).toBe(true);
    // Someone else's personal workspace: personal, not yours.
    expect(isOwnWorkspace(guestPersonal)).toBe(false);
    // A shared workspace you created: yours, not personal.
    expect(isOwnWorkspace(ownShared)).toBe(false);
    expect(isOwnWorkspace(guestShared)).toBe(false);
  });

  test("finds the one row that carries it, or nothing", () => {
    expect(ownWorkspace([guestPersonal, ownShared, own])?.id).toBe("own");
    expect(ownWorkspace([guestPersonal, guestShared])).toBeNull();
    expect(ownWorkspace([])).toBeNull();
  });
});

/**
 * The claim entry: the *gap* where the pinned row would be, drawn accented,
 * gone forever once used.
 */
describe("the claim entry", () => {
  test("is offered to somebody with no personal workspace of their own", () => {
    const group = railGroup({ contexts: [guestPersonal, ownShared], claimable: true });
    expect(group.claim).toBe(true);
  });

  /**
   * It stands in for the pinned row, so it can never sit above one. The gate
   * that offers it already counts owned personal contexts, and this is the
   * second lock: a placeholder beside the thing it is a placeholder for is
   * nonsense on the glass, and this is the one place that can refuse it.
   */
  test("never coexists with the workspace it stands in for", () => {
    const group = railGroup({ contexts: [own, guestShared], claimable: true });
    expect(group.claim).toBe(false);
  });

  test("keeps the list alive when it is the only thing in it", () => {
    // Somebody invited into a workspace and nothing else: without this the
    // way to have a workspace of your own is a row with nothing to sit in.
    const group = railGroup({ contexts: [guestShared], claimable: true });
    expect(group.contexts.map((c) => c.id)).toEqual(["pw"]);
    expect(group.claim).toBe(true);
  });

  test("is absent unless it is offered", () => {
    expect(railGroup({ contexts: [own], claimable: false }).claim).toBe(false);
    expect(railGroup({ contexts: [], claimable: false }).claim).toBe(false);
  });
});

/**
 * The create entry: an ordinary verb at the foot of the list, drawn quietly,
 * true from the first session and every one after it.
 */
describe("the create-workspace entry", () => {
  test("is offered whenever the rail has somewhere to send it", () => {
    const group = railGroup({ contexts: [own, guestShared], claimable: false, creatable: true });
    expect(group.create).toBe(true);
  });

  test("is absent unless it is offered", () => {
    expect(railGroup({ contexts: [ownShared], claimable: false }).create).toBe(false);
  });

  /**
   * A brand-new account offered both: one list, the claim entry in the pinned
   * slot and the create entry at the foot of it.
   */
  test("coexists with the claim entry, one list holding both", () => {
    const group = railGroup({ contexts: [], claimable: true, creatable: true });
    expect(group.claim).toBe(true);
    expect(group.create).toBe(true);
    expect(group.contexts).toEqual([]);
  });
});
