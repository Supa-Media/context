/**
 * @jest-environment jsdom
 *
 * A published site wears its workspace's icon in the browser tab, and gives
 * the Context favicon back when the visitor leaves it.
 *
 * What this holds: an emoji becomes an SVG the browser can draw, encoded so no
 * character of it can end the attribute or the markup; a photo becomes a data
 * URL of its own bytes; showing one hides the page's own icon links rather
 * than competing with them, and restoring puts those exact nodes back where
 * they were; and each handle is asked about once per session.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import {
  emojiFaviconHref,
  resetSiteFaviconCache,
  showFavicon,
  siteFaviconHref,
  type SiteIconAnswer,
} from "../features/site/siteFavicon";

afterEach(() => {
  document.head.innerHTML = "";
  resetSiteFaviconCache();
});

function seedContextFavicon(): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "shortcut icon";
  link.href = "/favicon.ico";
  document.head.appendChild(link);
  const after = document.createElement("meta");
  after.name = "after";
  document.head.appendChild(after);
  return link;
}

function iconHrefs(): string[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')).map(
    (link) => link.getAttribute("href") ?? "",
  );
}

describe("an emoji favicon", () => {
  test("is an SVG data URL that draws the emoji", () => {
    const href = emojiFaviconHref("🪐");
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(href.slice("data:image/svg+xml,".length));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/);
    expect(svg).toContain(">🪐</text>");
  });

  test("cannot close the markup it sits in, whatever it is handed", () => {
    // The server only stores single emoji; this is the second lock.
    const href = emojiFaviconHref('</text><script>x</script>"&');
    expect(href).not.toMatch(/[<>"'\s]/);
    const svg = decodeURIComponent(href.slice("data:image/svg+xml,".length));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;/text&gt;&lt;script&gt;x&lt;/script&gt;&quot;&amp;");
  });
});

describe("showing and restoring", () => {
  test("the site's icon replaces the page's, and leaving puts the same nodes back", () => {
    const original = seedContextFavicon();
    const restore = showFavicon(document, "data:image/png;base64,AAAA");
    expect(iconHrefs()).toEqual(["data:image/png;base64,AAAA"]);
    expect(original.isConnected).toBe(false);

    restore();
    expect(iconHrefs()).toEqual(["/favicon.ico"]);
    // The very node, in its place — not a copy that drops Expo's attributes.
    expect(document.head.firstElementChild).toBe(original);
  });

  test("restoring twice is harmless", () => {
    seedContextFavicon();
    const restore = showFavicon(document, "data:image/png;base64,AAAA");
    restore();
    restore();
    expect(iconHrefs()).toEqual(["/favicon.ico"]);
  });

  test("a page with no favicon of its own is left with none", () => {
    const restore = showFavicon(document, "data:image/png;base64,AAAA");
    expect(iconHrefs()).toHaveLength(1);
    restore();
    expect(iconHrefs()).toEqual([]);
  });
});

describe("asking the server", () => {
  test("a photo becomes a data URL of its own bytes", async () => {
    const read = jest.fn(
      async (): Promise<SiteIconAnswer> => ({
        kind: "photo",
        bytes: new Uint8Array([1, 2, 3]).buffer,
        contentType: "image/png",
      }),
    );
    expect(await siteFaviconHref("atlas", read)).toBe("data:image/png;base64,AQID");
  });

  test("no icon, and a failed call, are both the Context favicon", async () => {
    expect(await siteFaviconHref("none", async () => null)).toBeNull();
    expect(
      await siteFaviconHref("broken", async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  test("each handle is asked about once, however many pages are opened", async () => {
    const read = jest.fn(async (): Promise<SiteIconAnswer> => ({ kind: "emoji", emoji: "🪐" }));
    const first = siteFaviconHref("atlas", read);
    const second = siteFaviconHref("atlas", read);
    expect(await first).toBe(await second);
    await siteFaviconHref("atlas", read);
    expect(read).toHaveBeenCalledTimes(1);
    await siteFaviconHref("other", read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
