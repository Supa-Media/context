/**
 * The page viewer's pure half (`page-viewer/viewerCore.ts`): which addresses
 * it answers, where everything else goes, and when a stored sign-in is used
 * rather than refreshed.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `pageAddressFrom` without the `.page.md` check → "answers only a page".
 *  2. `pageAddressFrom` keeping `..` → "refuses a path that climbs out".
 *  3. `tokenLasts` ignoring the margin → "a token about to run out is refreshed, not used".
 */
import { describe, expect, test } from "@jest/globals";
import { appLinkFor, authKeys, pageAddressFrom, pageTitle, pictureDataUrl, tokenLasts } from "../page-viewer/viewerCore";

function jwt(expiresInMs: number, now: number): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode({ exp: Math.floor((now + expiresInMs) / 1000), sub: "person" })}.signature`;
}

describe("pageAddressFrom", () => {
  test("reads the slug and the page's path, decoded", () => {
    expect(pageAddressFrom("/p/@Seyi/projects/trip%20plan/plan.page.md")).toEqual({ slug: "seyi", path: "projects/trip plan/plan.page.md" });
    expect(pageAddressFrom("/p/%40supa/x.page.md")).toEqual({ slug: "supa", path: "x.page.md" });
  });

  test("answers only a page", () => {
    expect(pageAddressFrom("/p/@seyi/notes/plain.md")).toBeNull();
    expect(pageAddressFrom("/note/@seyi/x.page.md")).toBeNull();
  });

  test("refuses a path that climbs out, an encoded slash, or a name that can't be a workspace", () => {
    for (const path of ["/p/@seyi/../x.page.md", "/p/@seyi/a/./x.page.md", "/p/@seyi/a%2Fb.page.md", "/p/seyi/x.page.md", "/p/@BAD!/x.page.md", "/p/@seyi/%E0%A4%A.page.md"]) {
      expect(pageAddressFrom(path)).toBeNull();
    }
  });
});

describe("appLinkFor", () => {
  test("is the app's own link to the same note, and the app's front door for anything else", () => {
    expect(appLinkFor({ slug: "seyi", path: "projects/trip plan/plan.page.md" })).toBe("/note/@seyi/projects/trip%20plan/plan.page.md");
    expect(appLinkFor(null)).toBe("/app");
  });
});

describe("the stored sign-in", () => {
  test("uses the keys the app's sign-in writes for this control plane", () => {
    expect(authKeys("https://example-deployment.convex.cloud")).toEqual({
      jwt: "__convexAuthJWT_httpsexampledeploymentconvexcloud",
      refresh: "__convexAuthRefreshToken_httpsexampledeploymentconvexcloud",
    });
  });

  test("a token about to run out is refreshed, not used", () => {
    const now = Date.UTC(2026, 10, 10, 12);
    expect(tokenLasts(jwt(10 * 60_000, now), 60_000, now)).toBe(true);
    expect(tokenLasts(jwt(30_000, now), 60_000, now)).toBe(false);
    expect(tokenLasts(jwt(-1, now), 60_000, now)).toBe(false);
    expect(tokenLasts("not-a-token", 60_000, now)).toBe(false);
    expect(tokenLasts(null, 60_000, now)).toBe(false);
  });
});

describe("pageTitle", () => {
  test("is the first heading, past the front matter, else the file's name", () => {
    expect(pageTitle("---\nskill: x\n---\n\n# Linq fixes the previews\n\nWords", "a/b.page.md")).toBe("Linq fixes the previews");
    expect(pageTitle("No heading here", "a/trip-plan.page.md")).toBe("trip-plan");
  });
});

describe("pictureDataUrl", () => {
  test("turns the control plane's bytes into a picture, and nothing else", () => {
    expect(pictureDataUrl({ bytes: { $bytes: "AAAA" }, contentType: "image/png" })).toBe("data:image/png;base64,AAAA");
    expect(pictureDataUrl({ bytes: { $bytes: "AAAA" }, contentType: "text/html" })).toBeNull();
    expect(pictureDataUrl({ bytes: "AAAA", contentType: "image/png" })).toBeNull();
    expect(pictureDataUrl(null)).toBeNull();
  });
});
