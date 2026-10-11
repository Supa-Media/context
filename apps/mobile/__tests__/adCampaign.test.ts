import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The ad a visit came from (`features/auth/adCampaign.ts`), sent with the
 * sign-up. A fresh module per test, since what it remembers lives in the module.
 */
function load(): typeof import("../features/auth/adCampaign") {
  let mod: typeof import("../features/auth/adCampaign") | undefined;
  jest.isolateModules(() => {
    mod = require("../features/auth/adCampaign");
  });
  return mod!;
}

/** This suite runs without a DOM: a tab's session storage, as a map. */
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  (globalThis as { window?: unknown }).window = {
    location: { search: "" },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("the ad campaign", () => {
  test("is read on load from the address the visit arrived at", () => {
    (globalThis as { window: { location: { search: string } } }).window.location.search = "?utm_source=x&page=pricing";
    expect(load().adCampaign()).toEqual({ source: "x" });
  });

  test("is read from the landing query string", () => {
    const { captureAdCampaign, adCampaign } = load();
    expect(adCampaign()).toBeUndefined();
    captureAdCampaign("?utm_source=meta&utm_campaign=spring&utm_content=b-video");
    expect(adCampaign()).toEqual({ source: "meta", campaign: "spring", content: "b-video" });
  });

  test("the first ad of a session is kept, as the landing page is", () => {
    const { captureAdCampaign, adCampaign } = load();
    captureAdCampaign("?utm_source=meta");
    captureAdCampaign("?utm_source=x");
    captureAdCampaign("?page=pricing");
    expect(adCampaign()).toEqual({ source: "meta" });
  });

  test("survives a reload in the same tab", () => {
    load().captureAdCampaign("?utm_campaign=spring");
    expect(load().adCampaign()).toEqual({ campaign: "spring" });
  });

  test("a tampered stored value is cleaned or dropped, never trusted", () => {
    stored.set("context.campaign", "{not json");
    expect(load().adCampaign()).toBeUndefined();
    stored.set("context.campaign", JSON.stringify({ source: " meta ", evil: "x" }));
    expect(load().adCampaign()).toEqual({ source: "meta" });
  });
});
