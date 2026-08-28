import { describe, expect, test } from "@jest/globals";
import { railSections } from "../features/console/rail";
import type { ConsoleContext } from "../features/console/types";

/**
 * The rail's split: what you own under "Contexts", everything you were let
 * into under "Shared with you", and no header standing over an empty section.
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
const ownShared = context({ id: "team", slug: "team", role: "owner", kind: "shared" });
const guestPersonal = context({ id: "lk", slug: "lk", role: "member", kind: "personal" });
const guestShared = context({ id: "pw", slug: "public-worship", role: "editor", kind: "shared" });

describe("railSections", () => {
  test("splits on ownership, not on kind", () => {
    const sections = railSections({
      contexts: [own, guestPersonal, ownShared, guestShared],
      claimable: false,
    });

    expect(sections.map((s) => s.heading)).toEqual(["Contexts", "Shared with you"]);
    // A shared workspace you created is yours; somebody else's personal
    // context you were invited into is not — `kind` alone answers neither.
    expect(sections[0]!.contexts.map((c) => c.id)).toEqual(["own", "team"]);
    expect(sections[1]!.contexts.map((c) => c.id)).toEqual(["lk", "pw"]);
  });

  test("an account that was never invited anywhere gets no 'Shared with you'", () => {
    const sections = railSections({ contexts: [own], claimable: false });
    expect(sections.map((s) => s.heading)).toEqual(["Contexts"]);
  });

  test("an invited-only account gets no empty 'Contexts' header", () => {
    const sections = railSections({
      contexts: [guestPersonal, guestShared],
      claimable: false,
    });
    expect(sections.map((s) => s.heading)).toEqual(["Shared with you"]);
  });

  test("…unless the claim entry needs the group to live in", () => {
    // The durable decision: "Claim your @name" sits last in the Contexts
    // group, because that group raises the question it answers. Omitting the
    // header would orphan the one entry an invitee has to be able to find.
    const sections = railSections({ contexts: [guestShared], claimable: true });
    expect(sections.map((s) => s.heading)).toEqual(["Contexts", "Shared with you"]);
    expect(sections[0]!.contexts).toEqual([]);
    expect(sections[0]!.claim).toBe(true);
    expect(sections[1]!.claim).toBe(false);
  });

  test("an account with nothing at all keeps the 'Contexts' group for its empty state", () => {
    const sections = railSections({ contexts: [], claimable: false });
    expect(sections.map((s) => s.heading)).toEqual(["Contexts"]);
    expect(sections[0]!.contexts).toEqual([]);
  });
});
