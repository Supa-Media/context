import { describe, expect, test } from "@jest/globals";
import {
  atName,
  contextTone,
  describeScopes,
  formatCount,
  grantTone,
  lastUsedLabel,
  relativeTime,
} from "../features/console/format";
import { contextKindFor } from "../features/console/map/graph";
import { withAlpha } from "../features/design/color";
import {
  HERO_LONGEST_LINE_AT_98,
  heroHeadingWidth,
} from "../features/landing/hero";

const NOW = 1_800_000_000_000;
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;
const days = (n: number) => n * 86_400_000;

describe("relativeTime", () => {
  test("matches the phrases in the mockup", () => {
    expect(relativeTime(NOW - minutes(4), NOW)).toBe("4 minutes ago");
    expect(relativeTime(NOW - hours(2), NOW)).toBe("2 hours ago");
    expect(relativeTime(NOW - hours(26), NOW)).toBe("yesterday");
  });

  test("uses the singular where it should", () => {
    expect(relativeTime(NOW - minutes(1), NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW - hours(1), NOW)).toBe("1 hour ago");
  });

  test("a clock running ahead reads as 'just now', never a negative duration", () => {
    expect(relativeTime(NOW + hours(3), NOW)).toBe("just now");
  });

  test("scales past a day", () => {
    expect(relativeTime(NOW - days(5), NOW)).toBe("5 days ago");
    expect(relativeTime(NOW - days(70), NOW)).toBe("2 months ago");
    expect(relativeTime(NOW - days(800), NOW)).toBe("2 years ago");
  });
});

describe("lastUsedLabel", () => {
  test("an authorised client that never connected says so", () => {
    expect(lastUsedLabel(undefined, NOW)).toBe("never used");
  });

  test("otherwise reads as the mockup does", () => {
    expect(lastUsedLabel(NOW - minutes(4), NOW)).toBe("last used 4 minutes ago");
  });
});

describe("describeScopes", () => {
  test("a scope reaching private notes is full access", () => {
    expect(describeScopes(["private", "team"])).toBe("Full access");
    expect(describeScopes(["*"])).toBe("Full access");
  });

  test("team-only never reads as full access — that distinction is the product", () => {
    expect(describeScopes(["team"])).toBe("Team access only");
    expect(describeScopes(["context:team"])).toBe("Team access only");
  });

  /**
   * The line has to answer both questions somebody has about a client they
   * connected last month: how much can it see, and can it change anything.
   * Either fact alone leaves the other unanswered, and "is this read only?" was
   * one of the three things the screen could not say.
   */
  test("a narrowed grant reads as narrowed, tier and operations both", () => {
    expect(describeScopes(["context:read"])).toBe("Team access only · read-only");
    expect(describeScopes(["context:read", "context:write"])).toBe(
      "Team access only · read & write",
    );
    expect(describeScopes(["context:capture"])).toBe("Team access only · capture only");
  });

  test("the tier scope on the same grant changes the first half and only that", () => {
    expect(describeScopes(["context:read", "context:private"])).toBe(
      "Full access · read-only",
    );
    expect(describeScopes(["context:read", "context:write", "context:private"])).toBe(
      "Full access · read & write",
    );
  });

  test("an unrecognised scope set is shown rather than summarised away", () => {
    expect(describeScopes(["a", "b"])).toBe("a · b");
  });

  test("an unrecognised scope beside recognised ones is still said out loud", () => {
    // Never omit a scope: a grant carrying something this version cannot
    // describe must not be able to look narrower than it is.
    expect(describeScopes(["context:read", "wat:huh"])).toBe(
      "Team access only · read-only · wat:huh",
    );
  });

  test("no scopes is not the same as full access", () => {
    expect(describeScopes([])).toBe("No scopes");
  });
});

describe("grantTone", () => {
  test("an active, recently used grant is fine", () => {
    expect(grantTone("active", NOW)).toBe("ok");
  });

  test("an authorised client that has never connected is worth a second look", () => {
    expect(grantTone("active", undefined)).toBe("warn");
  });

  test("anything not active reads as critical", () => {
    expect(grantTone("revoked", NOW)).toBe("crit");
    expect(grantTone("expired", undefined)).toBe("crit");
  });
});

describe("contextTone", () => {
  test("a connected binding is green", () => {
    expect(contextTone("connected")).toBe("ok");
  });

  test("no binding at all is amber, not green", () => {
    expect(contextTone(undefined)).toBe("warn");
  });

  test("an errored binding is red", () => {
    expect(contextTone("error")).toBe("crit");
  });
});

describe("contextKindFor", () => {
  test("a workspace with other people in it stays shared whatever your role", () => {
    expect(contextKindFor("owner", "shared")).toBe("shared");
    expect(contextKindFor("member", "shared")).toBe("shared");
  });

  test("owning a personal workspace is your own context", () => {
    expect(contextKindFor("owner", "personal")).toBe("own");
  });

  test("anything else is access someone granted you", () => {
    expect(contextKindFor("member", "personal")).toBe("team");
    expect(contextKindFor("editor", "personal")).toBe("team");
  });
});

describe("names and counts", () => {
  test("slugs are addressed with an @, and never double-prefixed", () => {
    expect(atName("seyi")).toBe("@seyi");
    expect(atName("@seyi")).toBe("@seyi");
  });

  test("counts get thousands separators", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(0)).toBe("0");
  });
});

// The console navigation model moved out of this file when it stopped being a
// flat list of panes. See `consoleNav.test.ts`.

describe("withAlpha", () => {
  test("converts the palette's hex colours", () => {
    expect(withAlpha("#3B82F6", 0.27)).toBe("rgba(59,130,246,0.27)");
    expect(withAlpha("#000000", 0)).toBe("rgba(0,0,0,0)");
  });

  test("leaves anything it cannot parse alone rather than turning it black", () => {
    expect(withAlpha("rgba(1,2,3,.5)", 0.2)).toBe("rgba(1,2,3,.5)");
    expect(withAlpha("#abc", 0.2)).toBe("#abc");
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the hero                                  */
/* -------------------------------------------------------------------------- */

/**
 * The headline must hold each sentence on one line at desktop widths.
 *
 * It shipped wrapping to four lines, because `max-width: 14ch` had been ported
 * as a flat 780px — 14 characters of a typical sans, but not of Onest. Four
 * lines makes the dimmed second sentence dominate the page and pushes the
 * console demo below the fold, which is the effect the whole landing design is
 * built on. The measurements behind these numbers are in `features/landing/hero.ts`.
 */
describe("the hero heading fits its two lines", () => {
  test("14ch of Onest at 98px clears the longest line", () => {
    expect(heroHeadingWidth(98)).toBeGreaterThan(HERO_LONGEST_LINE_AT_98);
  });

  test("and does so at every size the clamp can produce", () => {
    for (const size of [46, 60, 75, 98]) {
      // The lines scale with the type, so the same ratio holds throughout.
      const longest = (HERO_LONGEST_LINE_AT_98 * size) / 98;
      expect(heroHeadingWidth(size)).toBeGreaterThan(longest);
    }
  });

  test("the old flat 780px did not — which is the bug this pins", () => {
    expect(780).toBeLessThan(HERO_LONGEST_LINE_AT_98);
  });
});
