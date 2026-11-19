/**
 * The look Publish keeps (`lib/websites/bakedDesign.ts`, decided by the owner
 * 2026-11-18): a visit draws the design composed at Publish instead of
 * rebuilding it from the live notes, and a design or page that cannot be read
 * is answered `incomplete`, never as "no design" or "no page", and never kept
 * at the edge.
 *
 * Sites went unstyled in production more than once because a rebuild that
 * failed half-way was answered as the site having no design (#1201, #2335).
 * Each test below makes one read fail and checks the visitor still gets the
 * site, or an answer the edge will not keep.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { fixture, publish, type Fixture } from "./website.helpers";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => vi.unstubAllGlobals());

const STYLES = ["The site's colours.", "", "```css", ":root { --accent: #C8102E; }", "h1 { color: var(--accent); }", "```"].join("\n");
const FRAME = ["```html", '<header class="band">Atlas</header><main>{ content }</main>', "```"].join("\n");
const SHOWCASE = ["```html", '<section class="show"><h1>Showcase</h1></section>', "```"].join("\n");

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 0\n---\n\n# Welcome\n\nPublished words.\n");
  f.backend.seed("website/layout.html.md", FRAME);
  f.backend.seed("website/styles.css.md", STYLES);
  f.backend.seed("website/showcase.html.md", SHOWCASE);
  await publish(f);
  return f;
}

const resolve = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

type Answer = { revision: string | null; cacheable: boolean; stale?: boolean; address: Record<string, unknown> };
async function edgeAnswer(f: Fixture, routePath: string): Promise<Answer> {
  const response = await f.t.fetch("/site/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "atlas", routePath }),
  });
  return (await response.json()) as Answer;
}

/**
 * Every bucket GET that `fails` picks answers 500, the way a storage outage or
 * a timed-out read does; everything else is the bucket as it is.
 */
function failReads(f: Fixture, fails: (key: string, body: string) => boolean): void {
  const real = f.backend.fetchImpl;
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const response = await real(input, init);
    if ((init.method ?? "GET").toUpperCase() !== "GET" || !response.ok) return response;
    const key = decodeURIComponent(new URL(typeof input === "string" ? input : String(input)).pathname);
    const body = await response.clone().text();
    if (!fails(key, body)) return response;
    return new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", {
      status: 500,
      headers: { "Content-Type": "application/xml" },
    });
  });
}

const releaseKeys = (f: Fixture) =>
  Object.keys(f.backend.snapshot()).filter((key) => key.startsWith(".context/website/releases/"));

describe("the look Publish keeps", () => {
  test("Publish keeps the composed, sanitized design beside the release's pages", async () => {
    const f = await site();
    const designs = releaseKeys(f).filter((key) => key.endsWith("/design.json"));
    expect(designs).toHaveLength(1);
    const kept = JSON.parse(String(f.backend.snapshot()[designs[0]!])) as {
      variants: Array<{ audience: string; layout: string | null; design: { css: string; frame: string } | null }>;
    };
    const plain = kept.variants.find((variant) => variant.audience === "public" && variant.layout === null);
    expect(plain?.design?.css).toContain(".ctx-site { --accent: #C8102E; }");
    expect(plain?.design?.frame).toContain('<header class="band">Atlas</header>');
  });

  test("a visit draws the kept look when the live stylesheet and its copy cannot be read", async () => {
    const f = await site();
    // Before: the rebuild's reads failed, were caught, and the page went out unstyled.
    failReads(f, (key, body) => !key.endsWith("/design.json") && body.includes("--accent"));
    const page = await resolve(f, "/");
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.design?.css).toContain("--accent: #C8102E");
    expect(page.design?.frame).toContain("band");
    expect(page.incomplete).toBeUndefined();
    const answer = await edgeAnswer(f, "/");
    expect(answer.cacheable).toBe(true);
  });

  test("an all-HTML page is drawn inside the kept look, with its own block", async () => {
    const f = await site();
    failReads(f, (key, body) => !key.endsWith("/design.json") && body.includes("--accent"));
    const page = await resolve(f, "/showcase");
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.design?.template).toContain('<section class="show">');
    expect(page.design?.css).toContain("--accent: #C8102E");
    expect(page.markdown).toBe("");
  });

  test("a kept design that cannot be read is incomplete: never kept at the edge, and the edge may serve its own copy", async () => {
    const f = await site();
    failReads(f, (key) => key.endsWith("/design.json"));
    const page = await resolve(f, "/");
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.design).toBeUndefined();
    expect(page.incomplete).toBe(true);
    const answer = await edgeAnswer(f, "/");
    expect(answer.cacheable).toBe(false);
    expect(answer.stale).toBe(true);
    // The flag is the edge's, not the visitor's.
    expect(answer.address).not.toHaveProperty("incomplete");
  });

  test("an all-HTML page whose design cannot be read is incomplete, not a blank page kept at the edge", async () => {
    const f = await site();
    failReads(f, (key) => key.endsWith("/design.json"));
    const answer = await edgeAnswer(f, "/showcase");
    expect(answer.cacheable).toBe(false);
    expect(answer.stale).toBe(true);
  });

  test("a page whose note cannot be read at all is incomplete, not missing", async () => {
    const f = await site();
    failReads(f, (_key, body) => body.includes("Published words."));
    const page = await resolve(f, "/");
    expect(page.kind).toBe("unavailable");
    if (page.kind !== "unavailable") return;
    expect(page.incomplete).toBe(true);
    const answer = await edgeAnswer(f, "/");
    expect(answer.cacheable).toBe(false);
    expect(answer.stale).toBe(true);
  });

  test("a release with no kept design (published before there were) is drawn from its notes as before", async () => {
    const f = await site();
    for (const key of releaseKeys(f).filter((held) => held.endsWith("/design.json"))) f.backend.objects.delete(key);
    const page = await resolve(f, "/");
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.design?.css).toContain("--accent: #C8102E");
    expect(page.incomplete).toBeUndefined();
  });

  test("a page that is really gone is unavailable and not incomplete", async () => {
    const f = await site();
    const page = await resolve(f, "/no-such-page");
    expect(page.kind).toBe("unavailable");
    if (page.kind !== "unavailable") return;
    expect(page.incomplete).toBeUndefined();
  });
});
