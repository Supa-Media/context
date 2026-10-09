/**
 * Moving between a site's pages draws the next one at once: answers are kept
 * for the tab, the menu's pages are fetched ahead, and a Publish or a
 * restriction (a move of the site's revision) drops everything kept.
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { ResolvedWebsiteAddress } from "@context/shared";
import {
  FRESH_MS,
  bodyLinks,
  PREFETCH_LIMIT,
  heldAnswer,
  keptAnswer,
  loadAnswer,
  noteRevision,
  noteShown,
  noteSignedIn,
  noteSiteClosed,
  prefetchLinked,
  prefetchPage,
  resetSiteAnswers,
  type SiteAsk,
} from "../features/site/siteAnswers";

const page = (routePath: string, navigation: string[] = []): ResolvedWebsiteAddress => ({
  kind: "page",
  siteName: "Acme",
  routePath,
  audience: "public",
  title: routePath,
  description: null,
  markdown: `${routePath}\n`,
  navigation: navigation.map((path) => ({ routePath: path, title: path })),
});

const answering = () =>
  jest.fn(async (ask: SiteAsk) => page(ask.routePath));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(resetSiteAnswers);

describe("answers kept for the tab", () => {
  test("an address asked once is kept, and asked for once however many want it", async () => {
    const ask = answering();
    const about = { handle: "acme", routePath: "/about" };
    const [one, two] = await Promise.all([loadAnswer(about, false, ask), loadAnswer(about, false, ask)]);
    expect(one).toEqual(page("/about"));
    expect(two).toBe(one);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(keptAnswer(about, false)?.view).toBe(one);
  });

  test("a kept answer goes stale after FRESH_MS but is still there to draw", async () => {
    let now = 1_000;
    const about = { handle: "acme", routePath: "/about" };
    await loadAnswer(about, false, answering(), () => now);
    expect(keptAnswer(about, false, now)?.fresh).toBe(true);
    now += FRESH_MS;
    expect(keptAnswer(about, false, now)).toEqual({ view: page("/about"), fresh: false });
  });

  test("signed in and signed out are kept apart", async () => {
    const about = { handle: "acme", routePath: "/about" };
    await loadAnswer(about, false, answering());
    expect(keptAnswer(about, true)).toBeUndefined();
  });

  test("an old short link and a page at the same address are kept apart", async () => {
    await loadAnswer({ handle: "acme", routePath: "/about", legacySlug: "about" }, false, answering());
    expect(keptAnswer({ handle: "acme", routePath: "/about" }, false)).toBeUndefined();
  });

  test("a failure is not kept, so the next visit asks again", async () => {
    const about = { handle: "acme", routePath: "/about" };
    const failing = jest.fn(async () => {
      throw new Error("offline");
    });
    await expect(loadAnswer(about, false, failing)).rejects.toThrow("offline");
    expect(keptAnswer(about, false)).toBeUndefined();
    await loadAnswer(about, false, answering());
    expect(keptAnswer(about, false)).toBeDefined();
  });
});

describe("a move of the site's revision", () => {
  test("the first sighting drops nothing; a move drops every answer kept for the site", async () => {
    await loadAnswer({ handle: "acme", routePath: "/about" }, false, answering());
    await loadAnswer({ handle: "acme", routePath: "/team" }, true, answering());
    await loadAnswer({ handle: "other", routePath: "/about" }, false, answering());
    expect(noteRevision("acme", "r1")).toBe(false);
    expect(keptAnswer({ handle: "acme", routePath: "/about" }, false)).toBeDefined();
    expect(noteRevision("acme", "r1")).toBe(false);
    expect(noteRevision("acme", "r2")).toBe(true);
    expect(keptAnswer({ handle: "acme", routePath: "/about" }, false)).toBeUndefined();
    expect(keptAnswer({ handle: "acme", routePath: "/team" }, true)).toBeUndefined();
    expect(keptAnswer({ handle: "other", routePath: "/about" }, false)).toBeDefined();
  });

  test("an answer asked before the move is never kept after it", async () => {
    noteRevision("acme", "r1");
    let release: (view: ResolvedWebsiteAddress) => void = () => {};
    const slow = jest.fn(() => new Promise<ResolvedWebsiteAddress>((resolve) => (release = resolve)));
    const about = { handle: "acme", routePath: "/about" };
    const asked = loadAnswer(about, false, slow);
    noteRevision("acme", "r2");
    release(page("/about"));
    await asked;
    expect(keptAnswer(about, false)).toBeUndefined();
  });
});

describe("fetching ahead", () => {
  test("a landed page fetches the menu's other pages, asked the way a click asks", async () => {
    const ask = answering();
    const home = { handle: "acme", routePath: "/" };
    const askFor = (routePath: string) => ({ handle: "acme", routePath, legacySlug: "x" });
    prefetchLinked(home, page("/", ["/", "/about", "/team", "/about"]), askFor, false, ask);
    await flush();
    expect(ask.mock.calls.map(([asked]) => asked)).toEqual([
      { handle: "acme", routePath: "/about", legacySlug: "x" },
      { handle: "acme", routePath: "/team", legacySlug: "x" },
    ]);
    expect(keptAnswer(askFor("/about"), false)?.fresh).toBe(true);
  });

  test("a long menu is fetched only as far as PREFETCH_LIMIT", async () => {
    const ask = answering();
    const paths = Array.from({ length: PREFETCH_LIMIT + 5 }, (_, index) => `/p${index}`);
    prefetchLinked({ handle: "acme", routePath: "/" }, page("/", paths), (routePath) => ({ handle: "acme", routePath }), false, ask);
    await flush();
    expect(ask).toHaveBeenCalledTimes(PREFETCH_LIMIT);
  });

  test("a page kept fresh is not asked for again; a failure ahead is silent", async () => {
    const ask = answering();
    const about = { handle: "acme", routePath: "/about" };
    await loadAnswer(about, false, ask);
    prefetchPage(about, false, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    const failing = jest.fn(async () => {
      throw new Error("offline");
    });
    prefetchPage({ handle: "acme", routePath: "/team" }, false, failing);
    await flush();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("holding the last page", () => {
  test("is per site and per sign-in state", () => {
    noteShown({ handle: "acme", routePath: "/" }, false, page("/"));
    expect(heldAnswer("acme", false)).toEqual(page("/"));
    expect(heldAnswer("acme", true)).toBeUndefined();
    expect(heldAnswer("other", false)).toBeUndefined();
  });
});

describe("signing in or out", () => {
  test("drops every answer kept, so the next account never sees the last one's pages", async () => {
    const about = { handle: "acme", routePath: "/about" };
    noteSignedIn(true);
    await loadAnswer(about, true, answering());
    noteShown(about, true, page("/about"));
    noteSignedIn(true);
    expect(keptAnswer(about, true)).toBeDefined();
    noteSignedIn(false);
    noteSignedIn(true);
    expect(keptAnswer(about, true)).toBeUndefined();
    expect(heldAnswer("acme", true)).toBeUndefined();
  });

  /**
   * `noteSignedIn` is only called while a site page is mounted. A visitor who
   * leaves the site, signs out, signs in as somebody else and comes back is
   * signed in both times it is asked, and the signed-out moment between them
   * was never seen — so "always passes through signed out" is true of the auth
   * state and not of the observed one.
   */
  test("an account switch the tab never watched still drops the last account's pages", async () => {
    const about = { handle: "acme", routePath: "/about" };
    noteSignedIn(true);
    await loadAnswer(about, true, answering());
    noteShown(about, true, page("/about"));
    expect(keptAnswer(about, true)).toBeDefined();

    noteSiteClosed();
    noteSignedIn(true);
    expect(keptAnswer(about, true)).toBeUndefined();
    expect(heldAnswer("acme", true)).toBeUndefined();
  });

  test("an answer asked before an unwatched gap is never kept after it", async () => {
    const about = { handle: "acme", routePath: "/about" };
    let settle = (view: ResolvedWebsiteAddress) => { void view; };
    const slow = jest.fn(async () => await new Promise<ResolvedWebsiteAddress>((resolve) => { settle = resolve; }));
    noteSignedIn(true);
    const asking = loadAnswer(about, true, slow);
    noteSiteClosed();
    noteSignedIn(true);
    settle(page("/about"));
    await asking;
    expect(keptAnswer(about, true)).toBeUndefined();
  });

  test("a signed-out answer survives the gap: it is not one account's", async () => {
    const about = { handle: "acme", routePath: "/about" };
    noteSignedIn(false);
    await loadAnswer(about, false, answering());
    noteShown(about, false, page("/about"));

    noteSiteClosed();
    noteSignedIn(false);
    expect(keptAnswer(about, false)).toBeDefined();
    expect(heldAnswer("acme", false)).toBeDefined();
  });

  test("a page kept but stale is not fetched ahead again", async () => {
    let now = 0;
    const ask = answering();
    const about = { handle: "acme", routePath: "/about" };
    await loadAnswer(about, false, ask, () => now);
    now += FRESH_MS * 10;
    prefetchPage(about, false, ask, () => now);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("links in a page's words", () => {
  test("are the rooted links and buttons, without #part, never a share or another site", () => {
    expect(
      bodyLinks(
        "See [about](/about#team), [caf%C3%A9](/caf%C3%A9) and [docs](https://example.com).\n\n" +
          "[[button: Join|/join]]\n\n- [share](/s/abc) and [//evil](//evil.example)\n",
      ),
    ).toEqual(expect.arrayContaining(["/about", "/café"]));
    const links = bodyLinks("[share](/s/abc) [x](//evil.example) [y](https://example.com)\n");
    expect(links).toEqual([]);
  });

  test("a landed page fetches what its words link to, as well as its menu", async () => {
    const ask = answering();
    const home: ResolvedWebsiteAddress = { ...page("/", ["/about"]), markdown: "Read [the team](/team).\n" } as ResolvedWebsiteAddress;
    prefetchLinked({ handle: "acme", routePath: "/" }, home, (routePath) => ({ handle: "acme", routePath }), false, ask);
    await flush();
    expect(ask.mock.calls.map(([asked]) => asked.routePath)).toEqual(["/about", "/team"]);
  });
});
