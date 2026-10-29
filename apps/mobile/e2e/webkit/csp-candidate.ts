import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The router's report-only Content-Security-Policy, **enforced**, for the
 * static server this suite runs against. Opt-in (`E2E_CSP_CANDIDATE`, one of
 * the modes below)
 * and never what production sends.
 *
 * The question this answers is the one quiet production reports cannot: does
 * the editor, the drawing editor and the plugin sandbox still work when the
 * report-only policy, or its script half, moves to the enforcing header? Reports only come from
 * paths somebody happened to use, so silence says nothing about the dynamic
 * ones (an inline `<style>` written on first use, `new Function` in a font
 * compressor, a plugin's script). Here the existing browser specs exercise
 * those paths on purpose, under exactly what the router would send, and a
 * blocked script or style fails them the way it would fail a person.
 *
 * Every policy is the router's own (`infra/router/src`), computed by calling
 * it, so the candidate cannot drift from what the router reports today:
 *
 *  - each document keeps the enforcing header it already has
 *    (`withSecurityHeaders`, and the sandbox page's own policy in
 *    `pluginSandbox.ts`), and `X-Frame-Options`;
 *  - the report-only policy for that path (`reportOnlyPolicyFor`), or its
 *    `script-src` alone, is sent as a **second enforcing**
 *    `Content-Security-Policy` as well as staying report-only, which is what
 *    moving it would do: a document obeys every policy it is given.
 *
 * The server picks a document's headers by the longest prefix below, the same
 * split `reportOnlyPolicyFor` makes (shell, drawing editor, plugin sandbox).
 * Violations still go to `/_csp-report`, where the server keeps only the
 * directive, the blocked source's origin or keyword, and the document's class.
 */

/** The fixture's control plane origin (`build:e2e-web`), never a real deployment. */
const FIXTURE_CONVEX_ORIGIN = "https://e2e-fixture.invalid";

const REPO = join(__dirname, "..", "..", "..", "..");

/** Where the router's report-only policy reports, and where the candidate's enforced copy reports instead. */
export const REPORT_PATH = "/_csp-report";
export const ENFORCED_REPORT_PATH = "/_csp-report/enforce";

export type CandidateRule = { prefix: string; document: string; headers: Record<string, string | string[]> };

/** The router's modules, through Playwright's own TypeScript loader (the router is typed for Workers, not this app). */
function router(file: string): Record<string, unknown> {
  const loaded: unknown = createRequire(__filename)(join(REPO, "infra/router/src", file));
  if (typeof loaded !== "object" || loaded === null) throw new Error(`${file} exported nothing`);
  return { ...loaded };
}

function value<T>(module: Record<string, unknown>, name: string, kind: "function" | "string"): T {
  const found = module[name];
  if (typeof found !== kind) throw new Error(`${name} is not a ${kind}`);
  return found as T;
}

/**
 * What is enforced on top of what production enforces:
 *
 *  - `production`: nothing; the router's headers exactly, report-only included.
 *  - `script`: the report-only policy's `script-src` alone, the bounded next
 *    step, so a blocked style or font cannot hide a blocked script or pass for one.
 *  - `full`: the whole report-only policy, every directive in it.
 */
export type CandidateMode = "production" | "script" | "full";

/** `policy` cut down to the directives named, keeping its `report-uri`. */
function only(policy: string, names: string[]): string {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => [...names, "report-uri"].includes(directive.split(/\s+/)[0] ?? ""))
    .join("; ");
}

/** What the router would send for a document under `prefix`, plus the candidate `mode` enforces. */
export function candidateRules(mode: CandidateMode): CandidateRule[] {
  const headers = router("securityHeaders.ts");
  const csp = router("cspReport.ts");
  const sandbox = router("pluginSandbox.ts");
  const harden = value<(response: Response, pathname: string, convexOrigin?: string) => Response>(
    headers,
    "withSecurityHeaders",
    "function",
  );
  const reportOnlyFor = value<(pathname: string, convexOrigin?: string) => string>(csp, "reportOnlyPolicyFor", "function");
  const editorPrefix = value<string>(csp, "EDITOR_PATH_PREFIX", "string");
  const sandboxPrefix = value<string>(sandbox, "PLUGIN_SANDBOX_PREFIX", "string");
  const sandboxPolicy = value<string>(sandbox, "ENFORCED_SANDBOX_POLICY", "string");

  const documents: { prefix: string; document: string; enforced?: string }[] = [
    { prefix: "/", document: "shell" },
    // The diagram renderer's page gets the shell's policy from the router;
    // a rule of its own here only names it in the report log.
    { prefix: "/drawing-assets/diagram/", document: "diagram" },
    { prefix: editorPrefix, document: "drawing-editor" },
    // The router answers this path itself and sets its own enforcing policy,
    // which `withSecurityHeaders` then leaves alone.
    { prefix: sandboxPrefix, document: "plugin-sandbox", enforced: sandboxPolicy },
  ];
  return documents.map(({ prefix, document, enforced }) => {
    const base = new Response("", enforced ? { headers: { "Content-Security-Policy": enforced } } : undefined);
    const sent = Object.fromEntries(harden(base, prefix, FIXTURE_CONVEX_ORIGIN).headers);
    const reportOnly = reportOnlyFor(prefix, FIXTURE_CONVEX_ORIGIN);
    if (sent["content-security-policy-report-only"] !== reportOnly) {
      throw new Error(`the router's report-only policy for ${prefix} is not reportOnlyPolicyFor's`);
    }
    const candidate = mode === "full" ? reportOnly : mode === "script" ? only(reportOnly, ["script-src"]) : null;
    // Its reports go to an address of their own: WebKit's reports carry no
    // disposition, so the address is the only way to tell an enforced
    // violation from one the report-only copy of the same policy sent.
    const added = candidate === null ? null : candidate.replace(`report-uri ${REPORT_PATH}`, `report-uri ${ENFORCED_REPORT_PATH}`);
    if (added !== null && !added.includes(`report-uri ${ENFORCED_REPORT_PATH}`)) {
      throw new Error(`the candidate for ${prefix} has no report-uri ${REPORT_PATH} to redirect`);
    }
    const rule: Record<string, string | string[]> =
      added === null ? { ...sent } : { ...sent, "content-security-policy": [sent["content-security-policy"] ?? "", added] };
    // HSTS on a plain-HTTP local server means nothing, and is left off.
    delete rule["strict-transport-security"];
    return { prefix, document, headers: rule };
  });
}

/** Write the rules and an empty report log for the static server; returns both paths. */
export function writeCandidate(outputDir: string, mode: CandidateMode): { rules: string; reports: string } {
  mkdirSync(outputDir, { recursive: true });
  const rules = join(outputDir, "csp-candidate-rules.json");
  const reports = join(outputDir, "csp-candidate-reports.jsonl");
  writeFileSync(rules, JSON.stringify(candidateRules(mode), null, 2));
  writeFileSync(reports, "");
  return { rules, reports };
}
