import { describe, expect, test } from "@jest/globals";
import {
  AD_CAMPAIGN_FIELD_MAX,
  adCampaignFromSearch,
  adCampaignLabel,
  adCampaignOf,
  DEFAULT_LANDING_PAGE,
  LANDING_PAGES,
  landingPageFromPath,
  landingPageOf,
} from "@context/shared";

/**
 * The three landing pages (`/a` to `/c`) and what they are named by. The
 * waitlist records which one a person saw (`landing`), so both the client that
 * reads the URL and the server that validates the value rely on this one rule.
 * The server half is in `apps/convex/__tests__/waitlist.test.ts`.
 */

describe("the landing pages", () => {
  test("are a, b, c and tex.lc's, with a as the default", () => {
    expect([...LANDING_PAGES]).toEqual(["a", "b", "c", "tex"]);
    expect(DEFAULT_LANDING_PAGE).toBe("a");
  });

  test("a stored value is kept only when it is exactly one of them", () => {
    for (const page of LANDING_PAGES) expect(landingPageOf(page)).toBe(page);
    for (const raw of ["z", "A", "<script>", "", " a", "a ", 1, null, undefined, ["a"]]) {
      expect(landingPageOf(raw)).toBeUndefined();
    }
  });

  test("the home page is the default, and /a to /c are their own pages", () => {
    expect(landingPageFromPath("/")).toBe("a");
    for (const page of ["a", "b", "c"]) {
      expect(landingPageFromPath(`/${page}`)).toBe(page);
      expect(landingPageFromPath(`/${page}/`)).toBe(page);
    }
  });

  test("tex.lc's page has no path here: it is drawn at / on a Tex host", () => {
    expect(landingPageFromPath("/tex")).toBeNull();
  });

  test("any other path is no landing page", () => {
    for (const path of ["", "/d", "/e", "/f", "/A", "/ab", "/a/b", "//a", "/a//", "/login", "/a?x=1", "a", "/a/c"]) {
      expect(landingPageFromPath(path)).toBeNull();
    }
  });
});

describe("the ad a visit came from", () => {
  test("is read from the UTM parameters, and only those", () => {
    expect(adCampaignFromSearch("?utm_source=meta&utm_medium=paid&utm_campaign=spring&utm_content=video-2&utm_term=notes&x=1")).toEqual({
      source: "meta",
      medium: "paid",
      campaign: "spring",
      content: "video-2",
      term: "notes",
    });
    expect(adCampaignFromSearch("?utm_campaign=spring")).toEqual({ campaign: "spring" });
    for (const search of ["", "?", "?page=pricing", "?utm_source=", "?utm_source=%20%20", "?twclid=abc"]) {
      expect(adCampaignFromSearch(search)).toBeUndefined();
    }
  });

  test("a stranger's text is trimmed, stripped of control characters and capped", () => {
    const long = "x".repeat(AD_CAMPAIGN_FIELD_MAX + 50);
    expect(adCampaignOf({ source: "  meta\n\u0000 ", campaign: long, medium: 7, content: ["a"], extra: "kept?" })).toEqual({
      source: "meta",
      campaign: "x".repeat(AD_CAMPAIGN_FIELD_MAX),
    });
    for (const raw of [undefined, null, "meta", 1, [], {}, { source: "" }, { source: "\u0000" }]) {
      expect(adCampaignOf(raw)).toBeUndefined();
    }
  });

  test("staff read it as source, campaign and ad", () => {
    expect(adCampaignLabel({ source: "meta", campaign: "spring", content: "video-2", medium: "paid" })).toBe("meta / spring / video-2");
    expect(adCampaignLabel({ campaign: "spring" })).toBe("spring");
    expect(adCampaignLabel({ medium: "paid" })).toBe("paid");
    expect(adCampaignLabel(undefined)).toBeNull();
  });
});
