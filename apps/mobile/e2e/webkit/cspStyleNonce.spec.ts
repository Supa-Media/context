import { expect, test } from "@playwright/test";

import { candidateRules, ENFORCED_REPORT_PATH, REPORT_PATH } from "./csp-candidate";
import { reportLines } from "./csp-report-log.mjs";
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
 * that a style without it is still blocked and reported, so a green run is
 * the nonce working and not the policy missing.
 *
 * Reports are caught here and never reach the run's report log, so the
 * deliberate refusal cannot hide one the editor specs caused.
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

test("the editor's own stylesheet carries the page's nonce and applies; a style without it is blocked and reported", async ({ page, baseURL }) => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full and E2E_CSP_NONCE=1");
  if (baseURL === undefined) throw new Error("no baseURL");
  const origin = new URL(baseURL).origin;
  const rules = candidateRules("full").sort((a, b) => b.prefix.length - a.prefix.length);
  const classify = (pathname: string): string => rules.find((rule) => pathname.startsWith(rule.prefix))?.document ?? "unmatched";
  const rows: ReturnType<typeof reportLines> = [];
  // Only the report sink is answered here; the shell, its nonce and the app come from the fixture server.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "POST" || (url.pathname !== REPORT_PATH && url.pathname !== ENFORCED_REPORT_PATH)) {
      return route.fallback();
    }
    rows.push(...reportLines(request.postData() ?? "", classify, url.pathname === ENFORCED_REPORT_PATH ? "enforce" : "report"));
    return route.fulfill({ status: 204, body: "" });
  });
  // Every refusal the page sees, with the element it refused, so a failure names what was not nonced.
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { __cspRefusals: unknown[] }).__cspRefusals = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      seen.push({
        directive: event.effectiveDirective,
        disposition: event.disposition,
        element: target === null ? null : `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`,
        nonced: target instanceof HTMLStyleElement ? target.nonce !== "" : null,
        sample: event.sample.slice(0, 60),
      });
    });
  });
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
  const refusals = () => page.evaluate(() => (window as unknown as { __cspRefusals: unknown[] }).__cspRefusals);
  const before = await refusals();
  console.log(`[${test.info().project.name}] refusals while the note opened ${JSON.stringify(before)}`);
  expect(before, "nothing the shell or the editor wrote was refused").toEqual([]);

  // The control: a style the nonce does not cover is still refused.
  const applied = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = "body { --csp-nonce-probe: 1; }";
    document.head.append(style);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return getComputedStyle(document.body).getPropertyValue("--csp-nonce-probe").trim() === "1";
  });
  expect(applied, "a style without the nonce is blocked").toBe(false);
  await expect.poll(() => rows.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const refusal = { document: "shell", directive: "style-src-elem", blocked: "inline" };
  const matches = (row: (typeof rows)[number]) =>
    row.document === refusal.document && row.directive === refusal.directive && row.blocked === refusal.blocked;
  expect(rows.filter(matches).map((row) => row.disposition).sort(), "one enforced refusal, and its report-only duplicate").toEqual(["enforce", "report"]);
  expect(rows.filter((row) => !matches(row)), "nothing else was reported").toEqual([]);
});
