import { describe, expect, test } from "vitest";
import {
  DEFAULT_WEBSITE_ROOT,
  WEBSITE_PLATFORM_ROOT_ASSET_PATTERN,
  compileWebsiteRoutes,
  type WebsiteRouteCompilation,
} from "@context/shared";

const SITE_SOURCES = import.meta.glob("../../../infra/router/src/site.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function routePairs(compilation: WebsiteRouteCompilation) {
  return compilation.routes.map(({ objectKey, routePath }) => ({
    objectKey,
    routePath,
  }));
}

function diagnosticPairs(compilation: WebsiteRouteCompilation) {
  return compilation.diagnostics.map(({ code, objectKeys, routePath }) => ({
    code,
    objectKeys,
    ...(routePath === undefined ? {} : { routePath }),
  }));
}

describe("website route path contract", () => {
  test("maps content files and index files to deterministic public routes", () => {
    const result = compileWebsiteRoutes([
      "website/writing/first-post.md",
      "website/about.md",
      "website/index.md",
      "website/writing/index.md",
    ]);

    expect(DEFAULT_WEBSITE_ROOT).toBe("website");
    expect(routePairs(result)).toEqual([
      { objectKey: "website/index.md", routePath: "/" },
      { objectKey: "website/about.md", routePath: "/about" },
      { objectKey: "website/writing/index.md", routePath: "/writing" },
      {
        objectKey: "website/writing/first-post.md",
        routePath: "/writing/first-post",
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores objects outside the exact root and non-Markdown assets", () => {
    const result = compileWebsiteRoutes([
      "Website/about.md",
      "notes/about.md",
      "website/",
      "website/avatar.png",
      "website/theme.css",
      "website/about.md",
    ]);

    expect(routePairs(result)).toEqual([
      { objectKey: "website/about.md", routePath: "/about" },
    ]);
    expect(result.ignoredObjectKeys).toEqual([
      "Website/about.md",
      "notes/about.md",
      "website/",
      "website/avatar.png",
      "website/theme.css",
    ]);
  });

  test("keeps the naming decision at one configurable boundary", () => {
    const result = compileWebsiteRoutes(
      ["website/about.md", "pages/index.md", "pages/about.md"],
      { root: "pages" },
    );

    expect(routePairs(result)).toEqual([
      { objectKey: "pages/index.md", routePath: "/" },
      { objectKey: "pages/about.md", routePath: "/about" },
    ]);
    expect(result.ignoredObjectKeys).toEqual(["website/about.md"]);
  });

  test("refuses a nested or otherwise unsafe root configuration", () => {
    expect(() => compileWebsiteRoutes([], { root: "nested/pages" })).toThrow(
      "one safe root-level folder",
    );
    expect(() => compileWebsiteRoutes([], { root: ".context" })).toThrow(
      "one safe root-level folder",
    );
  });

  test("treats Markdown extensions and index semantics case-insensitively", () => {
    const result = compileWebsiteRoutes(["website/Index.MD"]);

    expect(routePairs(result)).toEqual([
      { objectKey: "website/Index.MD", routePath: "/" },
    ]);
  });

  test("is input-order independent and ignores duplicate listing entries", () => {
    const forward = compileWebsiteRoutes([
      "website/z.md",
      "website/a.md",
      "website/a.md",
    ]);
    const reverse = compileWebsiteRoutes([
      "website/a.md",
      "website/z.md",
      "website/a.md",
    ]);

    expect(forward).toEqual(reverse);
    expect(routePairs(forward)).toEqual([
      { objectKey: "website/a.md", routePath: "/a" },
      { objectKey: "website/z.md", routePath: "/z" },
    ]);
  });

  test.each([
    ["website//about.md", "unsafe_path"],
    ["website/./about.md", "unsafe_path"],
    ["website/../private.md", "unsafe_path"],
    ["website/blog\\post.md", "unsafe_path"],
    ["website/about\nsecret.md", "unsafe_path"],
    ["website/about?.md", "unsafe_path"],
    ["website/about#.md", "unsafe_path"],
    ["website/.draft.md", "unsafe_path"],
    ["website/.md", "unsafe_path"],
    ["website/%2e%2e/private.md", "ambiguous_encoding"],
    ["website/100%.md", "ambiguous_encoding"],
  ] as const)("refuses %s with a stable %s diagnostic", (objectKey, code) => {
    const result = compileWebsiteRoutes([objectKey]);

    expect(result.routes).toEqual([]);
    expect(diagnosticPairs(result)).toEqual([
      { code, objectKeys: [objectKey] },
    ]);
  });

  test.each([
    "website/api/index.md",
    "website/_expo/app.md",
    "website/og/card.md",
    "website/robots.txt.md",
    "website/assets.md",
    "website/Preview/page.md",
    "website/.well-known/acme.md",
    "website/app.js.md",
    "website/logo.PNG.md",
    "website/@other/page.md",
  ])("refuses the platform-reserved route claimed by %s", (objectKey) => {
    const result = compileWebsiteRoutes([objectKey]);

    expect(result.routes).toEqual([]);
    expect(diagnosticPairs(result)).toEqual([
      {
        code: "reserved_path",
        objectKeys: [objectKey],
        routePath: expect.stringMatching(/^\//),
      },
    ]);
  });

  test("allows a reserved word below a non-reserved first segment", () => {
    const result = compileWebsiteRoutes(["website/guides/api.md"]);

    expect(routePairs(result)).toEqual([
      { objectKey: "website/guides/api.md", routePath: "/guides/api" },
    ]);
  });

  test("pins the custom-domain asset proxy and compiler to one extension pattern", () => {
    const siteSource = Object.values(SITE_SOURCES)[0];
    expect(siteSource, "infra/router/src/site.ts could not be read").toBeTypeOf(
      "string",
    );
    expect(siteSource).toContain(
      `\\.(?:${WEBSITE_PLATFORM_ROOT_ASSET_PATTERN})$`,
    );
  });

  test("removes every exact claimant when a direct file and index file collide", () => {
    const result = compileWebsiteRoutes([
      "website/contact.md",
      "website/about/index.md",
      "website/about.md",
      "website/index.md",
    ]);

    expect(routePairs(result)).toEqual([
      { objectKey: "website/index.md", routePath: "/" },
      { objectKey: "website/contact.md", routePath: "/contact" },
    ]);
    expect(diagnosticPairs(result)).toEqual([
      {
        code: "route_collision",
        objectKeys: ["website/about.md", "website/about/index.md"],
        routePath: "/about",
      },
    ]);
  });

  test("treats extension-only case differences as an exact route collision", () => {
    const result = compileWebsiteRoutes([
      "website/about.MD",
      "website/about.md",
    ]);

    expect(result.routes).toEqual([]);
    expect(diagnosticPairs(result)).toEqual([
      {
        code: "route_collision",
        objectKeys: ["website/about.MD", "website/about.md"],
        routePath: "/about",
      },
    ]);
  });

  test("removes every claimant whose route differs only by case", () => {
    const result = compileWebsiteRoutes([
      "website/About.md",
      "website/about.md",
      "website/contact.md",
    ]);

    expect(routePairs(result)).toEqual([
      { objectKey: "website/contact.md", routePath: "/contact" },
    ]);
    expect(diagnosticPairs(result)).toEqual([
      {
        code: "case_collision",
        objectKeys: ["website/About.md", "website/about.md"],
      },
    ]);
  });

  test("normalizes Unicode before detecting route collisions", () => {
    const result = compileWebsiteRoutes([
      "website/Caf\u00e9.md",
      "website/cafe\u0301.md",
      "website/notes.md",
    ]);

    expect(routePairs(result)).toEqual([
      { objectKey: "website/notes.md", routePath: "/notes" },
    ]);
    expect(diagnosticPairs(result)).toEqual([
      {
        code: "case_collision",
        objectKeys: ["website/Caf\u00e9.md", "website/cafe\u0301.md"],
      },
    ]);
  });

  test("retains the original bucket key while publishing the normalized route", () => {
    const result = compileWebsiteRoutes(["website/cafe\u0301.md"]);

    expect(result.routes).toEqual([
      {
        objectKey: "website/cafe\u0301.md",
        relativeFilePath: "cafe\u0301.md",
        routePath: "/caf\u00e9",
        lookupKey: "/caf\u00e9",
      },
    ]);
  });
});
