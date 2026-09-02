import { describe, expect, test } from "@jest/globals";
import { isOwnBrain, ownBrain, railSections } from "../features/console/rail";
import type { ConsoleContext } from "../features/console/types";

/**
 * The rail's split: **Brains** and **Workspaces**, ownership as a mark on one
 * row rather than a section boundary, and no header standing over a section
 * with nothing to show and nothing to offer.
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

describe("railSections", () => {
  test("splits on kind, not on ownership", () => {
    const sections = railSections({
      contexts: [own, guestPersonal, ownShared, guestShared],
      claimable: false,
    });

    expect(sections.map((s) => s.heading)).toEqual(["Brains", "Workspaces"]);
    // Somebody else's brain is still a brain; a workspace you created is still
    // a workspace. Neither `role` nor `kind` alone answered this before.
    expect(sections[0]!.contexts.map((c) => c.id)).toEqual(["own", "sayo"]);
    expect(sections[1]!.contexts.map((c) => c.id)).toEqual(["team", "pw"]);
  });

  /**
   * The pin that replaces the old section boundary. Your own brain is the row
   * you reach for most and the one the "yours" mark is on, so it leads its
   * group whatever order the control plane sent.
   */
  test("your own brain leads the Brains group", () => {
    const sections = railSections({
      contexts: [guestPersonal, ownShared, own],
      claimable: false,
    });
    expect(sections[0]!.contexts.map((c) => c.id)).toEqual(["own", "sayo"]);
  });

  /**
   * A pin, not a sort: everything after the own brain keeps the order it
   * arrived in. Re-ordering somebody's list on their behalf is a decision the
   * rail is not making, and a stable list is what makes muscle memory work.
   */
  test("everything else keeps the order it arrived in", () => {
    const b = context({ id: "b", slug: "bee", role: "member", kind: "personal" });
    const a = context({ id: "a", slug: "ay", role: "member", kind: "personal" });
    const sections = railSections({ contexts: [b, a, own], claimable: false });
    expect(sections[0]!.contexts.map((c) => c.id)).toEqual(["own", "b", "a"]);
  });

  test("a person with no workspaces gets no Workspaces header", () => {
    const sections = railSections({ contexts: [own, guestPersonal], claimable: false });
    expect(sections.map((s) => s.heading)).toEqual(["Brains"]);
  });

  test("a person with only workspaces gets no Brains header", () => {
    const sections = railSections({ contexts: [ownShared, guestShared], claimable: false });
    expect(sections.map((s) => s.heading)).toEqual(["Workspaces"]);
  });

  test("an account with nothing at all keeps Brains, for its empty state", () => {
    const sections = railSections({ contexts: [], claimable: false });
    expect(sections.map((s) => s.heading)).toEqual(["Brains"]);
    expect(sections[0]!.contexts).toEqual([]);
  });
});

/**
 * Where ownership went when it stopped being a section.
 *
 * Both halves of `isOwnBrain` are required and neither is sufficient — which is
 * the whole reason the old single-axis grouping could not express this.
 */
describe("the own-brain mark", () => {
  test("needs a personal context you own, and nothing else qualifies", () => {
    expect(isOwnBrain(own)).toBe(true);
    // Someone else's brain: personal, not yours.
    expect(isOwnBrain(guestPersonal)).toBe(false);
    // A workspace you created: yours, not a brain.
    expect(isOwnBrain(ownShared)).toBe(false);
    expect(isOwnBrain(guestShared)).toBe(false);
  });

  test("finds the one row that carries it, or nothing", () => {
    expect(ownBrain([guestPersonal, ownShared, own])?.id).toBe("own");
    expect(ownBrain([guestPersonal, guestShared])).toBeNull();
    expect(ownBrain([])).toBeNull();
  });
});

/**
 * The claim entry: a *gap* in the Brains list, drawn accented, gone forever
 * once used.
 */
describe("the claim entry", () => {
  test("rides in Brains, never in Workspaces", () => {
    const sections = railSections({
      contexts: [guestPersonal, ownShared],
      claimable: true,
    });
    expect(sections.map((s) => s.heading)).toEqual(["Brains", "Workspaces"]);
    expect(sections[0]!.claim).toBe(true);
    expect(sections[1]!.claim).toBe(false);
  });

  test("keeps the Brains group alive when it is the only thing in it", () => {
    // Somebody invited into a workspace and nothing else: without this the
    // group vanishes and the way to have a brain of your own vanishes with it.
    const sections = railSections({ contexts: [guestShared], claimable: true });
    expect(sections.map((s) => s.heading)).toEqual(["Brains", "Workspaces"]);
    expect(sections[0]!.contexts).toEqual([]);
    expect(sections[0]!.claim).toBe(true);
  });

  test("is absent unless it is offered", () => {
    const sections = railSections({ contexts: [own], claimable: false });
    expect(sections[0]!.claim).toBe(false);
  });
});

/**
 * The create entry: an ordinary verb at the foot of the Workspaces group,
 * drawn quietly, true from the first session and every one after it.
 */
describe("the create-workspace entry", () => {
  test("rides in Workspaces, never in Brains", () => {
    const sections = railSections({
      contexts: [own, guestShared],
      claimable: false,
      creatable: true,
    });
    expect(sections.map((s) => s.heading)).toEqual(["Brains", "Workspaces"]);
    expect(sections[0]!.create).toBe(false);
    expect(sections[1]!.create).toBe(true);
  });

  /**
   * How somebody who has only ever had a brain finds out workspaces exist. The
   * group is the entry, and it is the only content it has.
   */
  test("is the whole Workspaces group for somebody in none", () => {
    const sections = railSections({ contexts: [own], claimable: false, creatable: true });
    expect(sections.map((s) => s.heading)).toEqual(["Brains", "Workspaces"]);
    expect(sections[1]!.contexts).toEqual([]);
    expect(sections[1]!.create).toBe(true);
  });

  test("is absent unless it is offered", () => {
    const sections = railSections({ contexts: [ownShared], claimable: false });
    expect(sections[1] ?? sections[0]!).toMatchObject({ create: false });
  });

  /**
   * A brand-new account offered both: the empty state must not also render, or
   * "Nothing here yet" sits above two live offers.
   */
  test("coexists with the claim entry, one per group", () => {
    const sections = railSections({ contexts: [], claimable: true, creatable: true });
    expect(sections.map((s) => s.heading)).toEqual(["Brains", "Workspaces"]);
    expect(sections[0]!.claim).toBe(true);
    expect(sections[1]!.create).toBe(true);
  });
});
