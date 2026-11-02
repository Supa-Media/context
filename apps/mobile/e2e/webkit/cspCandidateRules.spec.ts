import { expect, test } from "@playwright/test";

import { candidateRules, ENFORCED_REPORT_PATH, REPORT_PATH } from "./csp-candidate";

/**
 * The candidate's headers, without a browser. WebKit's reports carry no
 * disposition, and in `full` mode the enforced copy is the report-only policy
 * word for word, so the one thing that tells their reports apart is where
 * each reports to. This holds that: every enforced copy reports to
 * `ENFORCED_REPORT_PATH`, the router's report-only policy still to
 * `REPORT_PATH`, and the two differ in nothing else.
 */
for (const mode of ["script", "full"] as const) {
  test(`${mode}: the enforced copy and the report-only policy report to different addresses`, () => {
    for (const rule of candidateRules(mode)) {
      const enforcing = rule.headers["content-security-policy"];
      const reportOnly = rule.headers["content-security-policy-report-only"];
      expect(Array.isArray(enforcing), rule.prefix).toBe(true);
      expect(typeof reportOnly, rule.prefix).toBe("string");
      const added = (enforcing as string[])[1] ?? "";
      expect(added, rule.prefix).toContain(`report-uri ${ENFORCED_REPORT_PATH}`);
      expect(reportOnly as string, rule.prefix).toContain(`report-uri ${REPORT_PATH}`);
      expect(reportOnly as string, rule.prefix).not.toContain(ENFORCED_REPORT_PATH);
      if (mode === "full") {
        expect(added.replace(ENFORCED_REPORT_PATH, REPORT_PATH), rule.prefix).toBe(reportOnly);
      }
    }
  });
}

test("production mode adds no enforced copy", () => {
  for (const rule of candidateRules("production")) {
    expect(Array.isArray(rule.headers["content-security-policy"]), rule.prefix).toBe(false);
    expect(JSON.stringify(rule.headers)).not.toContain(ENFORCED_REPORT_PATH);
  }
});
