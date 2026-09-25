/**
 * The shared wire shapes the Website settings card and public renderer consume.
 *
 * These tests are intentionally in the control-plane suite: the contract is
 * published by `@context/shared`, but Convex is the first producer and the app
 * is the first consumer. A change that makes either side invent its own count
 * or unavailable state should fail here before it becomes two implementations.
 */

import { describe, expect, test } from "vitest";

import {
  DEFAULT_WEBSITE_ROOT,
  WEBSITE_CONTRACT_VERSION,
  summarizeWebsiteRoutes,
  type ResolvedWebsitePage,
  type WebsiteRouteStatus,
  type WebsiteStateView,
} from "@context/shared";

describe("website contract", () => {
  test("the lifecycle view carries one root and a relative handle path", () => {
    const disabled: WebsiteStateView = {
      contractVersion: WEBSITE_CONTRACT_VERSION,
      state: "disabled",
      root: DEFAULT_WEBSITE_ROOT,
      handlePath: "/@atlas/",
      canManage: true,
    };
    const enabled: WebsiteStateView = {
      ...disabled,
      state: "enabled",
      enabledAt: 1_750_000_000_000,
    };

    expect(disabled).toEqual({
      contractVersion: 1,
      state: "disabled",
      root: "website",
      handlePath: "/@atlas/",
      canManage: true,
    });
    expect(enabled.enabledAt).toBe(1_750_000_000_000);
  });

  test("the route summary has one counting rule for the settings card", () => {
    const routes: WebsiteRouteStatus[] = [
      route("website/index.md", "/", "live", "public"),
      route("website/team.md", "/team", "live", "members"),
      route("website/later.md", "/later", "draft", "public"),
      {
        ...route("website/About.md", "/about", "problem", "public"),
        problems: [
          { code: "case_collision", message: "Two files claim this path." },
        ],
      },
    ];

    expect(summarizeWebsiteRoutes(routes)).toEqual({
      total: 4,
      public: 1,
      members: 1,
      drafts: 1,
      problems: 1,
    });
  });

  test("public resolution has no diagnostic-bearing failure variant", () => {
    const unavailable: ResolvedWebsitePage = {
      kind: "unavailable",
      siteName: null,
      navigation: [],
    };
    const signIn: ResolvedWebsitePage = {
      kind: "authentication_required",
      siteName: "Atlas",
      navigation: [],
      signInPath: "/sign-in?return=%2F%40atlas%2Fteam",
    };

    expect(Object.keys(unavailable).sort()).toEqual([
      "kind",
      "navigation",
      "siteName",
    ]);
    expect(Object.keys(signIn).sort()).toEqual([
      "kind",
      "navigation",
      "signInPath",
      "siteName",
    ]);
    expect(JSON.stringify([unavailable, signIn])).not.toMatch(
      /draft|collision|missing|private|member/i,
    );
  });
});

function route(
  objectKey: string,
  routePath: string,
  status: WebsiteRouteStatus["status"],
  audience: WebsiteRouteStatus["audience"],
): WebsiteRouteStatus {
  return {
    objectKey,
    routePath,
    status,
    audience,
    title: null,
    description: null,
    nav: null,
    problems: [],
  };
}
