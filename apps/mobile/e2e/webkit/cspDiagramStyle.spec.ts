import { type Page, expect, test } from "@playwright/test";

import { candidateRules } from "./csp-candidate";
import { goHome, tap, tapFolderOnHome, waitForNote } from "./helpers";

/**
 * Does the diagram page's own policy (`DIAGRAM_POLICY`, `infra/router/src/
 * cspReport.ts`), enforced, let Mermaid paint its diagram, and refuse
 * everything else a diagram could try?
 *
 * Under the shell's policy every diagram reported Mermaid's styles (blocker
 * 3 in `docs/decisions/testing/csp-candidate.md`). The router now gives the
 * page the policy its `<meta>` already enforces, and under
 * `E2E_CSP_CANDIDATE=full` the fixture enforces it as a second header too.
 *
 *  - Drawn in a note, Mermaid's own `<style>` applies: a node's fill is the
 *    theme's, not the SVG default black, and no frame refuses anything.
 *  - Opened on its own, the page still refuses a picture from the network,
 *    an inline script, a stylesheet by URL and a fetch, each by the enforced
 *    copy and in the report-only policy, while an inline style and a `data:`
 *    picture are allowed. A green run is the policy working, not missing.
 *
 * Refusals are read in the page from `securitypolicyviolation` events: WebKit's
 * report requests do not pass through Playwright's routing. The CI job runs
 * the control in a run of its own, before the drawn diagram, so its
 * deliberate refusals never land in the log the drawn diagram is checked by.
 */

const ON = process.env.E2E_CSP_CANDIDATE === "full";

type Refusal = { frame: string; directive: string; disposition: string };

async function recordRefusals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const holder = window as unknown as { __cspRefusals?: { frame: string; directive: string; disposition: string }[] };
    holder.__cspRefusals = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      const seen = { frame: window === window.top ? "top" : "diagram", directive: event.effectiveDirective, disposition: event.disposition };
      holder.__cspRefusals!.push(seen);
      // A frame's refusals are told to the top document, where the test reads them.
      if (window !== window.top) window.top?.postMessage({ channel: "csp-refusal", seen }, "*");
    });
    if (window === window.top) {
      window.addEventListener("message", (event) => {
        const data = event.data as { channel?: string; seen?: { frame: string; directive: string; disposition: string } };
        if (data?.channel === "csp-refusal" && data.seen) holder.__cspRefusals!.push(data.seen);
      });
    }
  });
}

const refusals = (page: Page) => page.evaluate(() => (window as unknown as { __cspRefusals: Refusal[] }).__cspRefusals);

test("the diagram page is served its own policy, enforced and reported", () => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full");
  const rule = candidateRules("full").find((candidate) => candidate.document === "diagram");
  if (rule === undefined) throw new Error("the candidate has no rule for the diagram page");
  const reportOnly = String(rule.headers["content-security-policy-report-only"]);
  expect(reportOnly).toMatch(/^default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:;/);
  const enforced = rule.headers["content-security-policy"] as string[];
  expect(enforced[1], "the candidate enforces the same policy").toBe(reportOnly.replace("report-uri /_csp-report", "report-uri /_csp-report/enforce"));
});

test("opened on its own, the page refuses the network, inline script and stylesheets by URL, and allows inline style", async ({ page }) => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full");
  await recordRefusals(page);
  await page.goto("/drawing-assets/diagram/index.html");
  const outcome = await page.evaluate(async () => {
    const holder = window as unknown as { __diagramProbeRan?: boolean };
    const style = document.createElement("style");
    style.textContent = "body { --diagram-probe: 1; }";
    document.head.append(style);
    const remote = new Image();
    const remoteDone = new Promise((resolve) => ((remote.onload = () => resolve("loaded")), (remote.onerror = () => resolve("refused"))));
    remote.src = "https://example.invalid/beacon.png";
    const inline = new Image();
    const inlineDone = new Promise((resolve) => ((inline.onload = () => resolve("loaded")), (inline.onerror = () => resolve("refused"))));
    inline.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    const script = document.createElement("script");
    script.textContent = "window.__diagramProbeRan = true;";
    document.body.append(script);
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = "/drawing-assets/diagram/probe.css";
    document.head.append(sheet);
    const fetched = await fetch("/drawing-assets/diagram/index.html").then(
      () => "fetched",
      () => "refused",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      inlineStyle: getComputedStyle(document.body).getPropertyValue("--diagram-probe").trim() === "1",
      remote: await remoteDone,
      dataPicture: await inlineDone,
      script: holder.__diagramProbeRan === true,
      fetched,
    };
  });
  expect(outcome).toEqual({ inlineStyle: true, remote: "refused", dataPicture: "loaded", script: false, fetched: "refused" });
  const seen = await refusals(page);
  console.log(`[${test.info().project.name}] diagram page refusals ${JSON.stringify(seen)}`);
  for (const directive of ["img-src", "script-src-elem", "style-src-elem", "connect-src"]) {
    const dispositions = new Set(seen.filter((row) => row.directive === directive).map((row) => row.disposition));
    expect([...dispositions].sort(), `${directive}: refused by an enforced policy and reported`).toEqual(["enforce", "report"]);
  }
  expect(seen.filter((row) => row.directive.startsWith("style-src") && row.directive !== "style-src-elem"), "the inline style itself was not refused").toEqual([]);
});

test("drawn in a note, Mermaid's own styles apply and nothing is refused", async ({ page }) => {
  test.skip(!ON, "needs E2E_CSP_CANDIDATE=full");
  await recordRefusals(page);
  await page.goto("/e2e-fixture");
  await page.getByTestId("note-scroll").waitFor();
  await goHome(page);
  await tapFolderOnHome(page, "areas");
  await tap(page, "architecture-map");
  await waitForNote(page, "Where the notes actually live");
  const drawn = page.frameLocator("iframe.cm-lp-diagram-frame");
  await expect(drawn.locator("svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.getByText("Your bucket")).toBeVisible();
  const frame = await (await page.locator("iframe.cm-lp-diagram-frame").elementHandle())!.contentFrame();
  const paint = await frame!.evaluate(() => {
    const node = document.querySelector("svg .node rect, svg .node polygon, svg .node path");
    return { fill: node === null ? null : getComputedStyle(node).fill, styles: document.querySelectorAll("svg style").length };
  });
  expect(paint.styles, "Mermaid wrote its stylesheet into the SVG").toBeGreaterThan(0);
  // Refused, Mermaid's rules never apply and a shape keeps the SVG default fill, black.
  expect(paint.fill, "and its node fill applies").not.toBeNull();
  expect(paint.fill).not.toBe("rgb(0, 0, 0)");
  await page.waitForTimeout(1500);
  const seen = await refusals(page);
  console.log(`[${test.info().project.name}] refusals while drawing ${JSON.stringify(seen)}`);
  expect(seen.filter((row) => row.frame === "diagram"), "nothing the diagram drew was refused").toEqual([]);
});
