/**
 * Website page metadata is a deliberately tiny YAML-shaped contract.
 *
 * The bucket file is authoritative, so malformed or ambiguous frontmatter
 * fails the route closed instead of being "helpfully" reinterpreted by a
 * different parser in each runtime.
 */

import { describe, expect, test } from "vitest";
import { buildWebsiteRouteStatuses, parseWebsitePage, websitePageTitle } from "@context/shared";

describe("website page metadata", () => {
  test("defaults a titled content page to a live public route", () => {
    expect(parseWebsitePage("---\ntitle: Home\n---\n\n# Welcome\n")).toEqual({
      audience: "public",
      draft: false,
      title: "Home",
      description: null,
      nav: null,
      body: "# Welcome\n",
      problems: [],
    });
  });

  test("parses the approved audience, draft and navigation fields", () => {
    expect(
      parseWebsitePage(
        "---\naudience: members\ndraft: true\ntitle: Team\ndescription: Current members only.\nnav: 3\n---\n\nPrivate body\n",
      ),
    ).toMatchObject({
      audience: "members",
      draft: true,
      title: "Team",
      description: "Current members only.",
      nav: 3,
      body: "Private body\n",
      problems: [],
    });
  });

  test("allows ordinary unrelated frontmatter without making it route state", () => {
    expect(
      parseWebsitePage(
        "---\ntitle: Notes\ntags: [site, notes]\nstatus: active\n---\n\nHello\n",
      ).problems,
    ).toEqual([]);
  });

  test.each([
    ["audience: everyone", "audience"],
    ["audience: Public", "audience"],
    ["draft: yes", "draft"],
    ["nav: -1", "nav"],
    ["nav: 1.5", "nav"],
    ["nav: 9007199254740992", "nav"],
    ["title: About\ntitle: Again", "title"],
    ["description: one\ndescription: two", "description"],
  ])(
    "fails closed for invalid controlled metadata: %s",
    (frontmatter, field) => {
      const parsed = parseWebsitePage(`---\n${frontmatter}\n---\n\nContent\n`);
      expect(parsed.problems).toEqual([
        {
          code: "invalid_metadata",
          message: expect.stringContaining(field),
        },
      ]);
    },
  );

  test("treats an unterminated frontmatter block as invalid", () => {
    expect(parseWebsitePage("---\ntitle: Home\n# body\n").problems).toEqual([
      {
        code: "invalid_metadata",
        message: "Website frontmatter is not closed.",
      },
    ]);
  });

  test("a missing title or an empty body is not a problem", () => {
    expect(parseWebsitePage("Body only\n").problems).toEqual([]);
    expect(parseWebsitePage("---\ntitle: Empty\n---\n\n  \n").problems).toEqual([]);
    expect(parseWebsitePage("").problems).toEqual([]);
  });

  test("an untitled page is titled by its first heading, else its file name", () => {
    expect(websitePageTitle("website/a.md", "Own", "# Heading\n")).toBe("Own");
    expect(websitePageTitle("website/a.md", null, "Intro\n\n# Use cases #\n")).toBe("Use cases");
    expect(websitePageTitle("website/Legal/use-cases.md", null, "")).toBe("use-cases");
    expect(
      buildWebsiteRouteStatuses([{ objectKey: "website/roadmap.md", markdown: "# Roadmap\n\nSoon.\n" }]),
    ).toMatchObject([{ status: "live", title: "Roadmap", routePath: "/roadmap" }]);
  });

  test("rejects multiline controlled values and invisible titles", () => {
    expect(
      parseWebsitePage(
        "---\ntitle: |\n  Secret\ndescription: ok\n---\n\nBody\n",
      ).problems,
    ).toEqual([
      {
        code: "invalid_metadata",
        message: "Website title must be a single-line scalar.",
      },
    ]);
    expect(
      parseWebsitePage('---\ntitle: "   "\n---\n\nBody\n').title,
    ).toBeNull();
  });

  test("normalizes CRLF without changing body line structure", () => {
    expect(
      parseWebsitePage("---\r\ntitle: Home\r\n---\r\n\r\nA\r\nB\r\n").body,
    ).toBe("A\nB\n");
  });
});

describe("website route statuses", () => {
  test("combines path ownership and page metadata deterministically", () => {
    const statuses = buildWebsiteRouteStatuses([
      {
        objectKey: "website/team.md",
        markdown: "---\ntitle: Team\naudience: members\nnav: 2\n---\n\nTeam\n",
      },
      {
        objectKey: "website/index.md",
        markdown: "---\ntitle: Home\nnav: 1\n---\n\nHome\n",
      },
      {
        objectKey: "website/later.md",
        markdown: "---\ntitle: Later\ndraft: true\n---\n\nLater\n",
      },
      { objectKey: "assets/logo.png", markdown: "not a page" },
    ]);

    expect(
      statuses.map(({ objectKey, routePath, status, audience, nav }) => ({
        objectKey,
        routePath,
        status,
        audience,
        nav,
      })),
    ).toEqual([
      {
        objectKey: "website/index.md",
        routePath: "/",
        status: "live",
        audience: "public",
        nav: 1,
      },
      {
        objectKey: "website/later.md",
        routePath: "/later",
        status: "draft",
        audience: "public",
        nav: null,
      },
      {
        objectKey: "website/team.md",
        routePath: "/team",
        status: "live",
        audience: "members",
        nav: 2,
      },
    ]);
  });

  test("a route problem wins over draft and neither colliding claimant is live", () => {
    const statuses = buildWebsiteRouteStatuses([
      {
        objectKey: "website/about.md",
        markdown: "---\ntitle: About\ndraft: true\n---\n\nOne\n",
      },
      {
        objectKey: "website/about/index.md",
        markdown: "---\ntitle: Other\n---\n\nTwo\n",
      },
    ]);

    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status).toMatchObject({
        routePath: "/about",
        status: "problem",
        problems: [
          {
            code: "route_collision",
            message: "Multiple website files claim /about.",
          },
        ],
      });
    }
  });

  test("case collisions retain each owner-facing path but publish neither", () => {
    const statuses = buildWebsiteRouteStatuses([
      { objectKey: "website/About.md", markdown: "---\ntitle: A\n---\n\nA\n" },
      { objectKey: "website/about.md", markdown: "---\ntitle: B\n---\n\nB\n" },
    ]);
    expect(statuses.map((status) => status.routePath)).toEqual([
      "/About",
      "/about",
    ]);
    expect(statuses.every((status) => status.status === "problem")).toBe(true);
    expect(
      statuses.every((status) => status.problems[0]?.code === "case_collision"),
    ).toBe(true);
  });

  test("metadata problems stay owner-facing and make the route inactive", () => {
    expect(
      buildWebsiteRouteStatuses([
        {
          objectKey: "website/nope.md",
          markdown: "---\ntitle: Nope\naudience: all\n---\n\nBody\n",
        },
      ])[0],
    ).toMatchObject({
      objectKey: "website/nope.md",
      routePath: "/nope",
      status: "problem",
      problems: [{ code: "invalid_metadata" }],
    });
  });
});
