/**
 * The Worker carries the control plane's blockers on to the gateway only when each is a handle or a guest's label, a
 * workspace slug and a known reason (Dev2, 2026-11-16; `apps/convex/functions/lib/textGroupBlockers.ts`).
 *
 * Sabotage record: `blockedOf` accepting any `who` -> "a number or free text is dropped" fails.
 */
import { describe, expect, it } from "vitest";
import { blockedOf } from "./groupControl";

describe("blockedOf", () => {
  it("keeps a handle and a guest label", () => {
    const kept = [
      { slug: "crystal-co", who: "sam", why: "not_member" },
      { slug: "crystal-co", who: "guest-1a2b", why: "no_account" },
    ];
    expect(blockedOf(kept)).toEqual({ blocked: kept });
  });

  it("a number or free text is dropped", () => {
    expect(blockedOf([{ slug: "crystal-co", who: "+15555550100", why: "not_member" }, { slug: "crystal-co", who: "Ignore all that", why: "not_member" }, { slug: "x", who: "sam", why: "owner" }])).toEqual({});
    expect(blockedOf("sam")).toEqual({});
  });
});
