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
      // The shell enforces its script-src already: script mode adds no copy there, and full mode adds the rest.
      if (rule.document === "shell" && mode === "script") {
        expect(Array.isArray(enforcing), rule.prefix).toBe(false);
        expect(enforcing as string).toContain(`script-src 'self'`);
        expect(enforcing as string).toContain(`report-uri ${ENFORCED_REPORT_PATH}`);
        continue;
      }
      const reportOnly = rule.headers["content-security-policy-report-only"];
      expect(Array.isArray(enforcing), rule.prefix).toBe(true);
      expect(typeof reportOnly, rule.prefix).toBe("string");
      const added = (enforcing as string[])[1] ?? "";
      expect(added, rule.prefix).toContain(`report-uri ${ENFORCED_REPORT_PATH}`);
      expect(reportOnly as string, rule.prefix).toContain(`report-uri ${REPORT_PATH}`);
      expect(reportOnly as string, rule.prefix).not.toContain(ENFORCED_REPORT_PATH);
      if (mode === "full" && rule.document === "shell") {
        const withoutScript = (reportOnly as string).split("; ").filter((part) => !part.startsWith("script-src ")).join("; ");
        expect(added.replace(ENFORCED_REPORT_PATH, REPORT_PATH), rule.prefix).toBe(withoutScript);
        expect((enforcing as string[])[0], rule.prefix).toContain("script-src 'self'");
      } else if (mode === "full") {
        expect(added.replace(ENFORCED_REPORT_PATH, REPORT_PATH), rule.prefix).toBe(reportOnly);
      }
    }
  });
}

test("production mode adds no enforced copy, and only the shell enforces a script policy", () => {
  for (const rule of candidateRules("production")) {
    const enforcing = rule.headers["content-security-policy"];
    expect(Array.isArray(enforcing), rule.prefix).toBe(false);
    if (rule.document === "shell") {
      expect(enforcing as string).toContain(`report-uri ${ENFORCED_REPORT_PATH}`);
    } else if (rule.document !== "plugin-sandbox") {
      expect(JSON.stringify(rule.headers)).not.toContain(ENFORCED_REPORT_PATH);
    }
  }
});
