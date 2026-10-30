import { expect, test } from "@playwright/test";

import { candidateRules, ENFORCED_REPORT_PATH, REPORT_PATH, type CandidateMode } from "./csp-candidate";
import { reportLines } from "./csp-report-log.mjs";

/**
 * Does the candidate actually block a script it does not allow, in a real
 * browser, and is the refusal reported as what it is?
 *
 * The checker's self-test proves the checker on fake reports; this proves
 * the browser side. It loads a shell path from the fixture's own server, so
 * the response carries exactly the headers that server sends for it, and
 * swaps only the body for one with an inline script no policy allows. Under
 * `script` or `full` the script must not run, and the enforced copy must
 * report one `script-src-elem` refusal of `inline` in the shell. Under
 * `production` it must run, with only the report-only policy reporting.
 *
 * The probe's own reports are caught here and never reach the run's report
 * log, so a refusal made on purpose cannot stand in for, or hide, one the
 * functional specs caused.
 */

const MODE = process.env.E2E_CSP_CANDIDATE;
const PROBE = '<!doctype html><html><head></head><body><script>window.__cspProbeRan = true;</script></body></html>';

test("an inline script the candidate does not allow is blocked, and reported as an enforced refusal", async ({ page, browserName, baseURL }) => {
  test.skip(MODE !== "production" && MODE !== "script" && MODE !== "full", "needs E2E_CSP_CANDIDATE");
  if (baseURL === undefined) throw new Error("no baseURL");
  const origin = new URL(baseURL).origin;
  const rules = candidateRules(MODE as CandidateMode).sort((a, b) => b.prefix.length - a.prefix.length);
  const classify = (pathname: string): string => rules.find((rule) => pathname.startsWith(rule.prefix))?.document ?? "unmatched";
  const rows: ReturnType<typeof reportLines> = [];
  let sentHeaders: Record<string, string> = {};
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.method() === "POST" && (url.pathname === REPORT_PATH || url.pathname === ENFORCED_REPORT_PATH)) {
      rows.push(...reportLines(request.postData() ?? "", classify, url.pathname === ENFORCED_REPORT_PATH ? "enforce" : "report"));
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === "/__csp-probe") {
      const response = await route.fetch();
      sentHeaders = response.headers();
      return route.fulfill({ status: 200, headers: sentHeaders, contentType: "text/html", body: PROBE });
    }
    return route.abort();
  });
  await page.goto(`${origin}/__csp-probe`);
  await page.waitForTimeout(1500);
  const ran = await page.evaluate(() => (window as unknown as { __cspProbeRan?: boolean }).__cspProbeRan === true);
  console.log(`[${browserName}:${MODE}] probe ran ${ran} reports ${JSON.stringify(rows)}`);

  // The probe was served with the server's own enforcing and report-only policies.
  expect(sentHeaders["content-security-policy-report-only"], "the report-only policy").toContain(`report-uri ${REPORT_PATH}`);
  const refusal = { document: "shell", directive: "script-src-elem", blocked: "inline" };
  const reported = rows.filter((row) => row.document === refusal.document && row.directive === refusal.directive && row.blocked === refusal.blocked);
  if (MODE === "production") {
    expect(ran, "nothing extra is enforced, so the script runs").toBe(true);
    expect(reported.map((row) => row.disposition), "only the report-only policy reports it").toEqual(["report"]);
  } else {
    expect(sentHeaders["content-security-policy"], "the enforced copy").toContain(`report-uri ${ENFORCED_REPORT_PATH}`);
    expect(ran, "the candidate blocks the script").toBe(false);
    expect(reported.map((row) => row.disposition).sort(), "one enforced refusal, and its report-only duplicate").toEqual(["enforce", "report"]);
  }
  expect(rows.filter((row) => !reported.includes(row)), "nothing else was reported").toEqual([]);
});
