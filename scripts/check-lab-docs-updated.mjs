#!/usr/bin/env node
/**
 * A change to the Lab or a preview updates the guide to them in the same pull request (Dev2, 2026-11-23: "make it a
 * standing rule in ci, claude.md and project rules to update these docs as updates are made to the lab and sandbox";
 * docs/decisions/testing/lab-docs.md).
 *
 * How to change search, Tex, Tex's quality and the nightly quickly is written in `docs/lab.md` (people),
 * `docs/preview-sandbox.md` (a pull request's preview) and `tex_dev { action: "guide" }` (agents,
 * `packages/lab/gateway/texDev/guide.js`). Those go stale one Lab change at a time, and a stale guide sends the next
 * person back to the slow loop. So a pull request that changes the Lab (`packages/lab/`), the preview sandbox
 * (`packages/sandbox/`) or their workflows touches at least one of those guides.
 *
 * A change that changes nothing a person or agent does through them (a bug fix, a refactor, a test) says so on a
 * line of its own in the description:
 *
 *   No Lab docs change: <why, in at least a few words>
 *
 *   node scripts/check-lab-docs-updated.mjs             # in CI: BASE_SHA, TEX_PR_BODY
 *   node scripts/check-lab-docs-updated.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { mergedOnto } from "./check-tex-change-has-case.mjs";

/** Files whose change changes the Lab, its test chats, its bench or the previews. */
export const LAB_CODE = [
  /^packages\/lab\/(gateway|app|src)\//,
  /^packages\/sandbox\/src\//,
  /^\.github\/workflows\/(deploy-preview|preview-[a-z-]+|lab-[a-z-]+|tex-lab-[a-z-]+)\.yml$/,
];
/** Tests and generated files change no guide. */
const NOT_BEHAVIOUR = [/\/__tests__\//, /\.test\.[cm]?[jt]sx?$/, /\.generated\.[a-z]+$/];
/** The guides. */
export const GUIDES = ["docs/lab.md", "docs/preview-sandbox.md", "packages/lab/gateway/texDev/guide.js"];
const EXEMPT = /^\s*No Lab docs change:\s*(.+?)\s*$/im;
const MIN_REASON = 12;

/** The verdict for one pull request: null when it may merge, else what is missing. */
export function verdict(files, body = "") {
  const lab = files.filter((file) => LAB_CODE.some((p) => p.test(file)) && !NOT_BEHAVIOUR.some((p) => p.test(file)) && !GUIDES.includes(file));
  if (lab.length === 0) return null;
  if (files.some((file) => GUIDES.includes(file))) return null;
  const reason = EXEMPT.exec(body ?? "")?.[1] ?? "";
  if (reason.length >= MIN_REASON) return null;
  const said = reason ? ` ("${reason}" is too short to be a reason)` : "";
  return (
    `This pull request changes the Lab or the previews (${lab.slice(0, 3).join(", ")}${lab.length > 3 ? ", ..." : ""}) and updates no guide to them.\n` +
    `Update docs/lab.md, docs/preview-sandbox.md or the tex_dev guide (packages/lab/gateway/texDev/guide.js) to match, and the Context note products/tex/how-it-works/making-changes-in-the-lab.md.\n` +
    `If nothing a person or agent does through them changes, say why in the description on its own line: "No Lab docs change: <why>"${said}.`
  );
}

function selfTest() {
  const cases = [
    ["a change outside the Lab needs nothing", ["apps/mobile/app/index.tsx"], "", true],
    ["a Lab gateway change with the guide passes", ["packages/lab/gateway/texDev/search.js", "packages/lab/gateway/texDev/guide.js"], "", true],
    ["a Lab app change with lab.md passes", ["packages/lab/app/views/Evals.web.tsx", "docs/lab.md"], "", true],
    ["a sandbox change with preview-sandbox.md passes", ["packages/sandbox/src/lab-bridge.mjs", "docs/preview-sandbox.md"], "", true],
    ["a Lab gateway change with no guide fails", ["packages/lab/gateway/bench/run.js"], "", false],
    ["a sandbox change with no guide fails", ["packages/sandbox/src/uiMatrix.mjs"], "", false],
    ["a preview workflow change with no guide fails", [".github/workflows/deploy-preview.yml"], "", false],
    ["a Lab workflow change with no guide fails", [".github/workflows/lab-eval-run.yml"], "", false],
    ["only the guide itself needs nothing more", ["packages/lab/gateway/texDev/guide.js"], "", true],
    ["tests alone need nothing", ["packages/lab/__tests__/texLabStepLogs.test.ts", "apps/mcp/test/benchRoute.test.mjs"], "", true],
    ["a generated file alone needs nothing", ["packages/lab/app/promptCatalog.generated.json"], "", true],
    ["a stated reason passes", ["packages/lab/gateway/labSandbox/intake.js"], "Body\n\nNo Lab docs change: fixes a crash, nothing anyone does changes\n", true],
    ["a token reason fails", ["packages/lab/gateway/labSandbox/intake.js"], "No Lab docs change: n/a", false],
    ["the reason must be its own line", ["packages/lab/gateway/labSandbox/intake.js"], "we said No Lab docs change: fixes a crash only", false],
  ];
  let failed = 0;
  for (const [name, files, body, passes] of cases) {
    const ok = (verdict(files, body) === null) === passes;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const { BASE_SHA, TEX_PR_BODY = "" } = process.env;
    if (!BASE_SHA) {
      console.log("check-lab-docs-updated: not a pull request (no BASE_SHA); nothing to check.");
      process.exit(0);
    }
    const base = mergedOnto() ?? BASE_SHA;
    const files = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const problem = verdict(files, TEX_PR_BODY);
    if (problem) {
      console.error(`::error::${problem.split("\n")[0]}`);
      console.error(problem);
      process.exit(1);
    }
    console.log(`check-lab-docs-updated: ${files.length} file(s) changed; the rule holds.`);
  }
}
