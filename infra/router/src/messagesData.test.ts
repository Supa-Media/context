/**
 * The data card pages (`messagesData.ts`): the shell of a page whose script
 * asks the extension for the person's own inbox or week, and the read-only
 * view of a card that came back.
 *
 * What the script does with the data was driven in Chromium with a fake
 * bridge when it was written (rows built with `textContent`, the sent card's
 * address and words); here the claims are the ones a deploy could break.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `DATA_SCRIPT` edited without its hash → "the data pages run only their own script" fails.
 *   `timesPage` reading `z` without `validZone` → "a card that came back shows what was sent" fails (throws).
 */

import { describe, expect, it } from "vitest";

import { BRIDGE_SCRIPT } from "./messagesCards";
import { messagesCardResponse } from "./messagesCards";
import { DATA_SCRIPT, DATA_SCRIPT_HASH, validZone } from "./messagesData";

async function page(path: string): Promise<{ status: number; html: string; headers: Headers }> {
  const url = new URL(`https://context.lc${path}`);
  const response = messagesCardResponse(new Request(url), url)!;
  return { status: response.status, html: await response.text(), headers: response.headers };
}

describe("the inbox and times pages", () => {
  it("the data pages run only their own script, allowed by its hash, and fetch nothing themselves", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DATA_SCRIPT));
    expect(`sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`).toBe(DATA_SCRIPT_HASH);
    for (const kind of ["inbox", "times"]) {
      const { status, html, headers } = await page(`/messages/${kind}`);
      expect(status).toBe(200);
      expect(html).toContain(`data-view="${kind}"`);
      expect(html).toContain(DATA_SCRIPT);
      expect(html).not.toContain(BRIDGE_SCRIPT);
      const policy = headers.get("Content-Security-Policy")!;
      expect(policy).toContain(`script-src '${DATA_SCRIPT_HASH}'`);
      expect(policy).not.toContain("connect-src");
      expect(policy).toContain("default-src 'none'");
    }
  });

  it("asks only for the gateway's card routes, and sets every word from the data as text", () => {
    const paths = [...DATA_SCRIPT.matchAll(/ask\("([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toEqual(["/cards/inbox", "/cards/week?from="]);
    expect(DATA_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // The only cards it builds are Tex's own addresses.
    expect([...DATA_SCRIPT.matchAll(/https:\/\/[^"]+/g)].map((m) => m[0])).toEqual(["https://context.lc/tex/inbox?", "https://context.lc/tex/times?d="]);
  });

  it("a card that came back shows what was sent, read from its address, and fetches nothing", async () => {
    const inbox = await page("/messages/inbox?m=me%40example.invalid%2F18c0ffee&m=<b>bad</b>");
    expect(inbox.html).toContain("Handed Tex 1 email");
    expect(inbox.html).not.toContain(DATA_SCRIPT);
    const times = await page("/messages/times?d=30&z=America%2FNew_York&s=2026-10-30T17:00:00.000Z&s=nope");
    expect(times.html).toContain("Fri, Oct 30, 1:00 PM");
    expect(times.html).toContain("In America/New_York.");
    expect(times.html).not.toContain(DATA_SCRIPT);
    const odd = await page("/messages/times?z=%3Cscript%3E&s=2026-10-30T17:00:00.000Z");
    expect(odd.html).toContain("In UTC.");
    expect(odd.html).not.toContain("<script>&");
  });

  it("knows a time zone from anything else", () => {
    expect(validZone("America/New_York")).toBe("America/New_York");
    expect(validZone("UTC")).toBe("UTC");
    expect(validZone("Mars/Olympus")).toBeNull();
    expect(validZone("../etc")).toBeNull();
    expect(validZone(null)).toBeNull();
  });

  it("the drawer links to both", async () => {
    const { html } = await page("/messages/drawer");
    expect(html).toContain('href="/messages/inbox"');
    expect(html).toContain('href="/messages/times"');
  });
});
