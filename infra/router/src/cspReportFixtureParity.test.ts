import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseCspReport } from "./cspReport";

/**
 * The browser suite's CSP candidate (`apps/mobile/e2e/webkit/csp-report-log.mjs`)
 * logs violation reports in plain Node, so it repeats the router's bounds
 * rather than importing them. This holds the two together on hostile input:
 * the directive and the blocked source must be what the router itself would
 * log, and no path, query, token or script sample may reach a fixture line.
 */

type Line = { document: string; directive: string; blocked: string; disposition: string };
type FixtureLog = {
  reportLines: (text: string, classify: (pathname: string) => string) => Line[];
  DOCUMENT_CLASSES: string[];
};

async function fixtureLog(): Promise<FixtureLog> {
  const file = join(__dirname, "..", "..", "..", "apps", "mobile", "e2e", "webkit", "csp-report-log.mjs");
  const loaded: unknown = await import(pathToFileURL(file).href);
  if (typeof loaded !== "object" || loaded === null) throw new Error("csp-report-log.mjs exported nothing");
  const { reportLines, DOCUMENT_CLASSES } = loaded as Record<string, unknown>;
  if (typeof reportLines !== "function" || !Array.isArray(DOCUMENT_CLASSES)) throw new Error("csp-report-log.mjs changed shape");
  return { reportLines: reportLines as FixtureLog["reportLines"], DOCUMENT_CLASSES: DOCUMENT_CLASSES as string[] };
}

/** Words that would only be in a line if a path, query or sample leaked. */
const SECRETS = ["acme", "secret", "tok_live", "hunter2", "notetitle", "alert", "projects", "%2F"];

const HOSTILE = [
  // Paths, queries and fragments on every URL field, and a script sample.
  {
    "csp-report": {
      "document-uri": "https://context.lc/note/@acme/projects/secret.md?token=tok_live#hunter2",
      "blocked-uri": "https://evil.example/projects/secret.js?token=tok_live",
      "effective-directive": "script-src-elem",
      "script-sample": "alert('secret')",
      disposition: "enforce",
    },
  },
  // A blocked-uri that is all letters and hyphens but no keyword CSP reports.
  { "csp-report": { "document-uri": "http://127.0.0.1:4874/", "blocked-uri": "secret-notetitle", "effective-directive": "style-src" } },
  // A directive carrying a path, and one far too long.
  { "csp-report": { "effective-directive": "script-src /projects/secret", "blocked-uri": "inline", disposition: "report" } },
  { "csp-report": { "effective-directive": `${"a".repeat(41)}`, "blocked-uri": "eval", disposition: "secret" } },
  // Non-string fields, and an opaque or data origin.
  { "csp-report": { "effective-directive": 7, "blocked-uri": { href: "https://acme.example/secret" }, "document-uri": ["x"] } },
  { "csp-report": { "blocked-uri": "data:text/html,<script>alert('secret')</script>", "document-uri": "about" } },
  { "csp-report": { "blocked-uri": "blob:https://context.lc/secret-uuid", "document-uri": "about:srcdoc" } },
  // The Reporting API's shape, one good entry beside junk.
  [
    {
      type: "csp-violation",
      body: {
        documentURL: "https://context.lc/console/@acme/projects/secret.md?q=hunter2",
        blockedURL: "https://cdn.example/a%2Fsecret?x=tok_live",
        effectiveDirective: "font-src",
        sample: "secret",
        disposition: "report",
      },
    },
    { type: "deprecation", body: { message: "secret" } },
    "secret",
  ],
];

describe("the browser suite's CSP log keeps the router's bounds", () => {
  it("agrees with parseCspReport on every directive and blocked source", async () => {
    const { reportLines } = await fixtureLog();
    for (const report of HOSTILE) {
      const text = JSON.stringify(report);
      const ours = parseCspReport(text).map(({ directive, blocked }) => ({ directive, blocked }));
      const fixture = reportLines(text, () => "shell").map(({ directive, blocked }) => ({ directive, blocked }));
      expect(fixture).toEqual(ours);
    }
  });

  it("never logs a path, a query, a token or a sample, even when a rule answers with one", async () => {
    const { reportLines, DOCUMENT_CLASSES } = await fixtureLog();
    for (const report of HOSTILE) {
      // A rule that tries to log the path itself is cut down to "unmatched".
      for (const line of reportLines(JSON.stringify(report), (pathname) => pathname)) {
        const logged = JSON.stringify(line);
        for (const secret of SECRETS) expect(logged).not.toContain(secret);
        expect(DOCUMENT_CLASSES).toContain(line.document);
        expect(["enforce", "report", "unknown"]).toContain(line.disposition);
        expect(Object.keys(line).sort()).toEqual(["blocked", "directive", "disposition", "document"]);
      }
    }
  });

  it("names the document by class and reads both report shapes", async () => {
    const { reportLines } = await fixtureLog();
    const classify = (pathname: string) => (pathname.startsWith("/drawing-assets/editor/") ? "drawing-editor" : "shell");
    const [legacy] = reportLines(JSON.stringify(HOSTILE[0]), classify);
    expect(legacy).toEqual({ document: "shell", directive: "script-src-elem", blocked: "https://evil.example", disposition: "enforce" });
    expect(reportLines(JSON.stringify(HOSTILE[5]), classify)[0]?.document).toBe("srcdoc-or-about");
    expect(reportLines(JSON.stringify(HOSTILE[7]), classify)).toEqual([
      { document: "shell", directive: "font-src", blocked: "https://cdn.example", disposition: "report" },
    ]);
    expect(reportLines("not json", classify)).toEqual([]);
  });
});
