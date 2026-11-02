/**
 * The Messages extension's pages (`messagesCards.ts`): a pure function of the
 * card's address, escaped, and the only addresses handed to the bridge are
 * cards the page built itself.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `escaped` returning its input → "never lets a name write markup" fails.
 *   `askPage` not checking the key → "an ask with a bad key offers nothing" fails.
 *   `BRIDGE_SCRIPT` edited without its hash → "the one script is the one its policy allows" fails.
 *   `cardPage` not checking `p` → "shows the drawing itself … never any other address" fails.
 */

import { describe, expect, it } from "vitest";

import worker from "./index";
import { BRIDGE_SCRIPT, BRIDGE_SCRIPT_HASH, messagesCardResponse } from "./messagesCards";

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function page(path: string): Promise<{ status: number; html: string; headers: Headers }> {
  const url = new URL(`https://context.lc${path}`);
  const response = messagesCardResponse(new Request(url), url)!;
  return { status: response.status, html: await response.text(), headers: response.headers };
}

/** Every request a page's buttons would hand the extension. */
function requests(html: string): { kind: string; url: string; caption: string }[] {
  return [...html.matchAll(/data-card="([^"]*)"/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")));
}

describe("a pick card's page", () => {
  it("lists the options, marks Tex's pick, and sends back the card with the choice", async () => {
    const { status, html } = await page("/messages/pick?p=1&o=Blend%20LIC&o=Lugo's&o=India%20Passage");
    expect(status).toBe(200);
    expect(html).toContain("Which one?");
    // Docked where the keyboard goes, never a sheet over the chat.
    expect(html).toContain('data-size="compact"');
    expect(html).toContain("Tex&#39;s pick");
    expect(requests(html)).toEqual([
      expect.objectContaining({ kind: "send", url: "https://context.lc/tex/pick?p=1&o=Blend%20LIC&o=Lugo's&o=India%20Passage&c=1", caption: "Picked: Blend LIC" }),
      expect.objectContaining({ url: "https://context.lc/tex/pick?p=1&o=Blend%20LIC&o=Lugo's&o=India%20Passage&c=2", caption: "Picked: Lugo's" }),
      expect.objectContaining({ url: expect.stringMatching(/&c=3$/) }),
    ]);
  });

  it("never lets a name write markup, and keeps at most eight short names", async () => {
    const evil = encodeURIComponent('<img src=x onerror=alert(1)>"\'');
    const { html } = await page(`/messages/pick?o=${evil}&o=b${"&o=x".repeat(20)}`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(requests(html)).toHaveLength(8);
    const long = await page(`/messages/pick?o=${"y".repeat(500)}&o=b`);
    expect(requests(long.html)[0].caption).toBe(`Picked: ${"y".repeat(60)}`);
  });

  it("with fewer than two options offers nothing", async () => {
    const { html } = await page("/messages/pick?o=only");
    expect(requests(html)).toEqual([]);
    expect(html).toContain("can't be answered here");
  });
});

describe("an ask card's page", () => {
  it("offers Yes and Not now, keyed to the ask", async () => {
    const { html } = await page("/messages/ask?k=fva95v");
    expect(requests(html)).toEqual([
      expect.objectContaining({ kind: "send", url: "https://context.lc/tex/ask?k=fva95v&c=1", caption: "Yes, go ahead" }),
      expect.objectContaining({ kind: "send", url: "https://context.lc/tex/ask?k=fva95v&c=2", caption: "Not now" }),
    ]);
  });

  it("an ask with a bad key offers nothing, and an answered one only says so", async () => {
    for (const key of ["", "NOT-A-KEY", "toolongkey", "a%22b"]) expect(requests((await page(`/messages/ask?k=${key}`)).html)).toEqual([]);
    const answered = await page("/messages/ask?k=fva95v&c=1");
    expect(requests(answered.html)).toEqual([]);
    expect(answered.html).toContain("You said yes.");
  });
});

describe("the drawer", () => {
  it("puts a hello card in the text field rather than sending one", async () => {
    expect(requests((await page("/messages/drawer")).html)).toEqual([expect.objectContaining({ kind: "insert", url: "https://context.lc/tex/hello", caption: "Context cards on" })]);
    expect(requests((await page("/messages/hello")).html)).toEqual([]);
  });
});

describe("a drawn card's page", () => {
  it("names the card, escaped, says how to change it, and hands the extension nothing", async () => {
    const opened = await page("/messages/card?t=%3Cb%3ETeam%20lunch%3C%2Fb%3E");
    expect(opened.status).toBe(200);
    expect(opened.html).toContain("&lt;b&gt;Team lunch&lt;/b&gt;");
    expect(opened.html).not.toContain("<b>Team");
    expect(opened.html).toContain("Reply to Tex in the chat");
    expect(requests(opened.html)).toEqual([]);
    expect((await page("/messages/card")).html).toContain("From Tex");
    expect(opened.html).not.toContain("<img");
  });

  it("shows the drawing itself, full size, when the card names where it is kept, and never any other address", async () => {
    const key = `${"a".repeat(64)}.${"b".repeat(64)}.png`;
    const opened = await page(`/messages/card?t=Team%20night&p=${key}`);
    expect(opened.html).toContain(`<img class="drawn" src="/messages/picture?p=${key}" alt="Team night">`);
    expect(opened.html).toContain('data-size="expanded"');
    for (const bad of ["https%3A%2F%2Fevil.example%2Fx.png", `${key}%22%3E%3Cscript%3E`, `${"a".repeat(64)}.${"b".repeat(64)}.svg`, "a.b.png"]) {
      expect((await page(`/messages/card?t=x&p=${bad}`)).html).not.toContain("<img");
    }
  });
});

describe("every page", () => {
  it("the one script is the one its policy allows, and nothing else may load", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BRIDGE_SCRIPT));
    expect(`sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`).toBe(BRIDGE_SCRIPT_HASH);
    const { html, headers } = await page("/messages/drawer");
    expect(html).toContain(`<script>${BRIDGE_SCRIPT}</script>`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(headers.get("Content-Security-Policy")).toBe(`default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src '${BRIDGE_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    expect(headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("is served by the router on its own path; anything else there is not found, and only GET reads it", async () => {
    const response = await worker.fetch(new Request("https://context.lc/messages/ask?k=abc"), {}, CTX);
    expect(response.status).toBe(200);
    expect(response.headers.get("Strict-Transport-Security")).toBeTruthy();
    expect((await worker.fetch(new Request("https://context.lc/messages/other"), {}, CTX)).status).toBe(404);
    expect((await worker.fetch(new Request("https://context.lc/messages/ask", { method: "POST" }), {}, CTX)).status).toBe(405);
  });
});
