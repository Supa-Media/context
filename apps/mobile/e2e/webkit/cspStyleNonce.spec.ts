import { type Page, expect, test } from "@playwright/test";

import { candidateRules } from "./csp-candidate";
import { NONCED_STYLE_IDS } from "./csp-style-nonce.mjs";
import { openWeeklyReview } from "./helpers";

/**
 * Does a style nonce minted per response let the note editor's own stylesheet
 * through an enforced `style-src` with no `'unsafe-inline'`, and nothing else?
 *
 * Under `E2E_CSP_CANDIDATE=full` with `E2E_CSP_NONCE=1` the fixture server
 * gives every shell document a fresh nonce (`csp-style-nonce.mjs`), and
 * `liveEditorWeb/styleNonce.ts` hands it to `EditorView.cspNonce`. This
 * checks the three places it has to agree (header, document, editor), that
 * it is new on every response and cannot be revalidated into a stale one, and
 * that a style without it is still blocked, by the enforced copy and in the
 * report-only policy, so a green run is the nonce working and not the policy
 * missing.
 *
 * Refusals are read in the page from `securitypolicyviolation` events. The
 * CI job runs this spec on its own, before the editor specs, so its
 * deliberate refusal never lands in the log the editor run is checked by.
 */

const ON = process.env.E2E_CSP_CANDIDATE === "full" && process.env.E2E_CSP_NONCE === "1";

const shellRules = candidateRules("full").filter((rule) => rule.document === "shell");

/** The `'nonce-…'` values in every `style-src` of a policy header, in order. */
function styleNonces(header: string | undefined): string[] {
  return (header ?? "")
    .split(/[;,]/)
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name === "style-src")
    .flatMap((sources) => sources.filter((source) => source.startsWith("'nonce-")).map((source) => source.slice(7, -1)));
}

/**
 * Refusals are read in the page, from every frame, not from the report requests: WebKit's
 * report requests do not pass through Playwright's routing, so a route would see none of them.
 */
async function recordRefusals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Seen = { frame: string; directive: string; disposition: string; element: string | null; nonced: boolean | null; text: string | null; source: string; line: number };
    const holder = window as unknown as { __cspRefusals?: Seen[] };
    holder.__cspRefusals = [];
    const path = (url: string) => {
      try {
        return new URL(url).pathname;
      } catch {
        return url.slice(0, 20);
      }
    };
    document.addEventListener("securitypolicyviolation", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const seen: Seen = {
        frame: window === window.top ? "top" : path(event.documentURI),
        directive: event.effectiveDirective,
        disposition: event.disposition,
        element: target === null ? null : `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`,
        nonced: target instanceof HTMLStyleElement ? target.nonce !== "" : null,
        // The first characters of a refused style: every style here is the export's or the fixture's own.
        text: target instanceof HTMLStyleElement ? (target.textContent ?? "").slice(0, 20) : null,
        source: path(event.sourceFile),
        line: event.lineNumber,
      };
      holder.__cspRefusals?.push(seen);
      // A same-origin frame's refusal is shown beside the top document's.
      try {
        if (window !== window.top) (window.top as unknown as { __cspRefusals?: Seen[] }).__cspRefusals?.push(seen);
      } catch {
        // An opaque frame cannot reach the top document; its refusals stay its own.
      }
    });
  });
}

test("every shell response carries its own nonce, the same in its policies and its styles, with nothing to revalidate", async ({ request }) => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full and E2E_CSP_NONCE=1");
  expect(shellRules.length, "the candidate has a shell rule").toBeGreaterThan(0);
  const seen: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await request.get("/e2e-fixture");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    // A validator would let a cache pair this body with a later response's header, or the reverse.
    expect(headers["etag"], "no validator").toBeUndefined();
    expect(headers["last-modified"], "no validator").toBeUndefined();
    expect(headers["cache-control"]).toBe("no-cache");
    const enforced = styleNonces(headers["content-security-policy"]);
    const reported = styleNonces(headers["content-security-policy-report-only"]);
    expect(enforced.length, "the enforced style-src carries a nonce").toBe(1);
    expect(reported, "the report-only style-src carries the same one").toEqual(enforced);
    const nonce = enforced[0];
    const body = await response.text();
    for (const id of NONCED_STYLE_IDS) expect(body, `<style id="${id}"> carries it`).toContain(`<style id="${id}" nonce="${nonce}">`);
    expect(body.split(`nonce="${nonce}"`).length - 1, "and nothing else in the document does").toBe(NONCED_STYLE_IDS.length);
    seen.push(nonce);
  }
  expect(new Set(seen).size, "a new nonce for every response").toBe(2);
});

test("the editor's own stylesheet carries the page's nonce and applies; a style without it is blocked", async ({ page }) => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full and E2E_CSP_NONCE=1");
  // Refusals are read in the page, from every frame, not from the report requests: WebKit's
  // report requests do not pass through Playwright's routing, so a route would see none of them.
  await recordRefusals(page);
  const refusals = () => page.evaluate(() => (window as unknown as { __cspRefusals: unknown[] }).__cspRefusals);
  const served = page.waitForResponse((response) => new URL(response.url()).pathname === "/e2e-fixture");
  await openWeeklyReview(page);
  const nonce = styleNonces((await served).headers()["content-security-policy"])[0];
  expect(nonce, "the shell was served with a nonce").toBeTruthy();

  const editor = await page.evaluate(() => {
    const ground = document.getElementById("context-ground") as HTMLStyleElement | null;
    // style-mod's element: the one `<style>` holding CodeMirror's base theme.
    const mod = Array.from(document.querySelectorAll("style")).find((style) => style.textContent?.includes(".cm-content"));
    const host = document.querySelector(".cm-editor");
    return {
      page: ground?.nonce ?? null,
      editor: mod?.nonce ?? null,
      // `.cm-editor { display: flex }` is in CodeMirror's base theme; blocked, it falls back to block.
      display: host === null ? null : getComputedStyle(host).display,
    };
  });
  expect(editor.page, "the page's nonce is readable from its style").toBe(nonce);
  expect(editor.editor, "CodeMirror's stylesheet carries it").toBe(nonce);
  expect(editor.display, "and its rules apply").toBe("flex");

  // Settled, then another note (the editor is made again, and style-mod's one element per document is reused).
  await page.waitForTimeout(3000);
  const settled = await refusals();
  await page.locator(".cm-note-link").first().click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.waitForTimeout(3000);
  const afterSecond = await refusals();
  console.log(`[${test.info().project.name}] refusals settled ${JSON.stringify(settled)} after a second note ${JSON.stringify(afterSecond)}`);
  expect(afterSecond, "nothing the shell or the editor wrote was refused, on either note").toEqual([]);

  // The control: a style the nonce does not cover is still refused, by the enforced copy and reported by the report-only policy.
  const applied = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.id = "csp-nonce-control";
    style.textContent = "body { --csp-nonce-probe: 1; }";
    document.head.append(style);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return getComputedStyle(document.body).getPropertyValue("--csp-nonce-probe").trim() === "1";
  });
  expect(applied, "a style without the nonce is blocked").toBe(false);
  const control = (await refusals()) as { element: string | null; directive: string; disposition: string }[];
  expect(
    control.filter((row) => row.element === "style#csp-nonce-control" && row.directive === "style-src-elem").map((row) => row.disposition).sort(),
    "one enforced refusal, and its report-only duplicate",
  ).toEqual(["enforce", "report"]);
  expect(control.filter((row) => row.element !== "style#csp-nonce-control"), "and nothing else").toEqual([]);
});

/*
  Where the editor run's refusals come from. Every one is `style-src-elem` in
  the shell document with no source file, line or sample, about one per test,
  and none is seen while a test runs. `screenshot: "only-on-failure"` takes a
  screenshot of every page as its context closes, kept only if the test failed,
  and in WebKit (`wkPage.shouldToggleStyleSheetToSyncAnimations`) Playwright's
  screenshot first appends `<style>body {}</style>` to the document from its
  utility world and removes it, to sync animations. WebKit holds that element
  to the page's policy, which no nonce of the page's covers, and Chromium never
  inserts it. This takes the same screenshot the recorder does, in the test, so
  the refusal is seen and named rather than inferred.
*/
test("Playwright's own screenshot, in WebKit, appends a style the page's nonce does not cover", async ({ page, browserName }) => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full and E2E_CSP_NONCE=1");
  await recordRefusals(page);
  const refusals = async () => (await page.evaluate(() => (window as unknown as { __cspRefusals: unknown[] }).__cspRefusals)) as { frame: string; directive: string; disposition: string; element: string | null; nonced: boolean | null; text: string | null }[];
  await openWeeklyReview(page);
  await page.waitForTimeout(3000);
  expect(await refusals(), "nothing refused before the screenshot").toEqual([]);
  // The recorder's own call (playwright/lib/index.js, `SnapshotRecorder`).
  await page.screenshot({ timeout: 5000, caret: "initial" });
  await page.waitForTimeout(500);
  const after = await refusals();
  console.log(`[${test.info().project.name}] refusals after a screenshot ${JSON.stringify(after)}`);
  const expected =
    browserName === "webkit"
      ? ["enforce", "report"].map((disposition) => ({ frame: "top", directive: "style-src-elem", disposition, element: "style", nonced: false, text: "body {}" }))
      : [];
  expect(
    after.map(({ frame, directive, disposition, element, nonced, text }) => ({ frame, directive, disposition, element, nonced, text })).sort((a, b) => a.disposition.localeCompare(b.disposition)),
    "exactly the screenshot's own style, refused and reported, and nothing else",
  ).toEqual(expected);
});
