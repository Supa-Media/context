/**
 * A visitor who is not signed in reads a website page from the copy the
 * router keeps per Publish. The ask carries the address and nothing else (no
 * cookies), and anything but a well-formed answer is `null`, so the page
 * falls back to asking Convex rather than showing nothing.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { edgeAddressUrl, fetchEdgeAddress } from "../features/site/edgeAddress";

const PAGE = {
  kind: "page",
  siteName: "Acme",
  routePath: "/about",
  audience: "public",
  title: "About",
  description: null,
  markdown: "We make things.\n",
  navigation: [],
};

const answering = (response: () => Response) =>
  jest.fn(async (_url: string, _init?: RequestInit) => response());

describe("the router's copy of a page", () => {
  test("asks the page's own origin for the address, without credentials", async () => {
    const fetchImpl = answering(() => Response.json(PAGE));
    const got = await fetchEdgeAddress({ handle: "acme", routePath: "/about" }, "https://context.lc", fetchImpl as unknown as typeof fetch);
    expect(got).toEqual(PAGE);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ credentials: "omit" });
  });

  test("names a legacy slug when there is one", () => {
    expect(edgeAddressUrl("https://docs.acme.com", { handle: "acme", routePath: "/", legacySlug: "hi" })).toBe(
      "https://docs.acme.com/_site/page?handle=acme&path=%2F&legacy=hi",
    );
  });

  test("anything else is null, so Convex is asked instead", async () => {
    const ask = (response: () => Response) =>
      fetchEdgeAddress({ handle: "acme", routePath: "/" }, "https://context.lc", answering(response) as unknown as typeof fetch);
    expect(await ask(() => new Response("{}", { status: 503 }))).toBeNull();
    expect(await ask(() => Response.json({ kind: "surprise" }))).toBeNull();
    expect(await ask(() => new Response("<html>", { status: 200 }))).toBeNull();
    expect(await ask(() => { throw new Error("offline"); })).toBeNull();
    expect(await fetchEdgeAddress({ handle: "acme", routePath: "/" }, null, answering(() => Response.json(PAGE)) as unknown as typeof fetch)).toBeNull();
  });
});
