/**
 * THE COMMITTED BUNDLE IS BUILT FROM UNCHANGED SOURCES — WHICH IS NOT THE SAME
 * SENTENCE AS "THE COMMITTED BUNDLE IS THE CODE IN THIS REPOSITORY".
 *
 * This file used to open with the second sentence, and did not check it. The
 * difference was a working supply-chain hole: appending a
 * `navigator.sendBeacon` snippet to the `EDITOR_BUNDLE` string passed every
 * assertion below and all 2,459 mobile tests, because no *source* file was
 * touched and nothing in the payload needs `eval`. A guard whose header claims
 * more than it checks is worse than no guard, because it is the sentence the
 * next reader trusts instead of looking.
 *
 * So what this file actually proves is the staleness half, and it proves it
 * well. `bundle.generated.ts` holds the iOS editor as one minified script,
 * built by `scripts/build-editor-bundle.mjs` — the only way an offline app with
 * a pinned `runtimeVersion` can ship a DOM library, see the script for the
 * argument. Its failure mode is somebody editing `livePreview.ts`, running the
 * suite, seeing green, and shipping a phone build running last month's editor.
 * The generator records a SHA-256 of every repository file that went into the
 * bundle and the resolved version of every package that did, both read out of
 * esbuild's own metafile rather than from a list somebody maintains. This
 * recomputes both.
 *
 * It deliberately does **not** run esbuild. Rebuilding here would make the
 * check depend on a bundler that is not a declared dependency of this app, and
 * would turn "you forgot to rebuild" into a slow test rather than a fast
 * message. The point is to fail with the command to run.
 *
 * **The other half — that the committed bytes are what those sources build — is
 * the `editor-bundle` job in `.github/workflows/ci.yml`**, which rebuilds and
 * diffs. It can only live there for the same reason this file cannot run
 * esbuild, and the last test below pins it, because a check that exists in one
 * file and is relied upon by the header of another is a check that gets deleted
 * by somebody tidying a workflow.
 */

import { describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BUNDLE_DEPENDENCIES,
  BUNDLE_SOURCES,
  EDITOR_BUNDLE,
} from "../features/console/files/webview/bundle.generated";

const mobileRoot = resolve(__dirname, "..");
const repoRoot = resolve(mobileRoot, "..", "..");
const REBUILD = "run `node scripts/build-editor-bundle.mjs` from the repo root";

/**
 * The installed version of a package, found the way node finds the package
 * itself.
 *
 * Not `require("<pkg>/package.json")`: several `@codemirror` packages declare
 * an `exports` map with no `./package.json` entry, so that throws for exactly
 * the dependencies this test is about.
 */
function installedVersion(name: string): string {
  const require = createRequire(join(mobileRoot, "package.json"));
  let directory = dirname(require.resolve(name, { paths: [mobileRoot] }));
  for (let depth = 0; depth < 12; depth += 1) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === name) return parsed.version;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not find an installed ${name}`);
}

describe("the bundle is current", () => {
  test("it records the sources it was built from", () => {
    // A guard whose input list emptied itself would pass every assertion below
    // and check nothing. These are the five modules the editor is made of plus
    // the entry point.
    expect(Object.keys(BUNDLE_SOURCES).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(BUNDLE_SOURCES)).toContain(
      "apps/mobile/features/console/files/livePreview.ts",
    );
    expect(Object.keys(BUNDLE_SOURCES)).toContain(
      "apps/mobile/features/console/files/editorSetup.ts",
    );
  });

  test("and every one of them is unchanged since it was built", () => {
    const stale: string[] = [];
    for (const [path, expected] of Object.entries(BUNDLE_SOURCES)) {
      const file = join(repoRoot, path);
      if (!existsSync(file)) {
        stale.push(`${path} (missing)`);
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (actual !== expected) stale.push(path);
    }
    expect(stale.length === 0 ? "" : `${stale.join(", ")} — ${REBUILD}`).toBe("");
  });

  test("and every package in it is at the version it was built from", () => {
    const moved: string[] = [];
    for (const [name, expected] of Object.entries(BUNDLE_DEPENDENCIES)) {
      const actual = installedVersion(name);
      if (actual !== expected) moved.push(`${name} ${expected} -> ${actual}`);
    }
    expect(moved.length === 0 ? "" : `${moved.join(", ")} — ${REBUILD}`).toBe("");
  });

  test("CodeMirror and lezer are in it, which is the whole reason it exists", () => {
    expect(Object.keys(BUNDLE_DEPENDENCIES)).toEqual(
      expect.arrayContaining([
        "@codemirror/state",
        "@codemirror/view",
        "@codemirror/lang-markdown",
        "@lezer/markdown",
      ]),
    );
  });
});

/**
 * THE WHOLE POINT OF THE BUNDLE: CodeMirror is on the other side of it.
 *
 * The native app ships the editor as a *string*. If the React Native module
 * graph ever imported `@codemirror/*` directly it would be carrying the editor
 * twice — once as source Hermes has to parse and once as the bundle — and it
 * would put a DOM library in `apps/mobile`'s dependency tree, which is the move
 * `livePreview.ts`'s own header calls out as what broke native rendering twice
 * in the sibling app.
 *
 * Nothing enforces that today except which import somebody types. One line in
 * `LiveEditor.tsx` would do it, it would typecheck, every test would pass, and
 * the only symptom would be a bigger bundle. So the native path's imports are
 * read and checked.
 */
describe("the native path never imports the editor, only the bundle", () => {
  const NATIVE_PATH = [
    "features/console/files/LiveEditor.tsx",
    "features/console/files/webview/host.ts",
    "features/console/files/webview/protocol.ts",
  ];

  const FORBIDDEN = [
    "@codemirror/",
    "@lezer/",
    "./livePreview",
    "../livePreview",
    "./editorSetup",
    "../editorSetup",
    "./webview/guest",
    "./webview/styles",
    "./webview/entry",
    "./guest",
    "./styles",
    "./entry",
  ];

  for (const file of NATIVE_PATH) {
    test(`${file} imports none of the editor's own modules`, () => {
      const source = readFileSync(join(mobileRoot, file), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      const offending = specifiers.filter((specifier) =>
        FORBIDDEN.some((bad) => specifier === bad || specifier.startsWith(bad)),
      );
      expect(offending).toEqual([]);
    });
  }
});

describe("what shipped is a script and nothing else", () => {
  test("it is minified browser code, not a module graph", () => {
    expect(EDITOR_BUNDLE.startsWith('"use strict";(()=>{')).toBe(true);
    // An IIFE, so nothing is exported and nothing has to be imported. A bundle
    // with a bare `import` in it would silently do nothing inside a classic
    // `<script>`.
    expect(EDITOR_BUNDLE).not.toMatch(/^\s*import\s/m);
  });

  test("nothing in it evaluates a string", () => {
    // The document renders somebody's private markdown. It never becomes code —
    // CodeMirror writes text nodes — and there is no interpreter in here that
    // could change that.
    expect(EDITOR_BUNDLE).not.toContain("eval(");
    expect(EDITOR_BUNDLE).not.toContain("new Function(");
  });

  /**
   * ...AND NEITHER OF THOSE IS THE CHECK THAT MATTERS, WHICH IS WHY THIS EXISTS.
   *
   * The two assertions above are shape checks on an attacker-controlled 500kb
   * string: an exfiltration snippet appended to the bundle starts
   * `"use strict";(()=>{`, is over 100kb, and needs no `eval`. The only thing
   * that closes it is rebuilding from source and comparing bytes, and that runs
   * in CI rather than here — esbuild is deliberately not a dependency of
   * `apps/mobile`.
   *
   * A guard in another file is a guard that can be deleted without this suite
   * noticing, so the job is read. Named steps rather than the whole script: the
   * message and the artifact are free to be reworded, but a `ci.yml` with no
   * rebuild and no diff in it is this file's header become false again.
   */
  test("and what it IS is proved by rebuilding, in CI, which must still be there", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    /*
      Comments stripped, and every assertion anchored to a line of shell rather
      than to a substring — because the first version of this test was not, and
      the sabotage run caught it. Deleting the rebuild step outright left the
      test green: the job's own header names the script, and so does the failure
      message it prints. That is this repository's "an import guard that read
      English prose as code", reproduced inside the fix for it.
    */
    const code = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toMatch(/^\s+run: node scripts\/build-editor-bundle\.mjs\s*$/m);
    expect(code).toMatch(
      /^\s+file=apps\/mobile\/features\/console\/files\/webview\/bundle\.generated\.ts\s*$/m,
    );
    expect(code).toMatch(/^\s+if git diff --quiet -- "\$file"; then\s*$/m);
    // On `pull_request`, or it is a check that runs after the merge.
    expect(code).toMatch(/^on:\n\s+pull_request:/m);

    /*
      And the job must actually run, and must actually block.

      Everything above pins that the *steps exist*, which is a different claim.
      Measured: adding `if: false` and `continue-on-error: true` to this job
      leaves all of these green while the guard does nothing at all — and that
      is not a hypothetical, it is this file's own neighbour. `ci.yml` records
      three lines above this job that `ci / Lint` "reported skipping on every
      PR for months", and that `lint-continue-on-error` defaults to true
      upstream, so "even once the job runs, a lint failure would be reported as
      a pass". Both halves of that trap are reachable here by one line each.

      Scoped to this job's own block rather than the whole file, so a legitimate
      `if:` on some unrelated job cannot fail this and cannot satisfy it either.
    */
    const start = code.indexOf("\n  editor-bundle:");
    expect(start).toBeGreaterThan(-1);
    // From the line after the job's own key, so the search below does not
    // match `editor-bundle:` itself and cut the block to nothing.
    const rest = code.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z-]*:\n/);
    const job = next === -1 ? rest : rest.slice(0, next);
    expect(job).toMatch(/^\s+run: node scripts\/build-editor-bundle\.mjs\s*$/m);
    /*
      Job-level keys only — four spaces. A *step* may carry an `if:`, and one
      here does: the artifact upload is `if: failure()`, which is the whole
      point of it. Forbidding `if:` at any depth caught that and would have
      made this test refuse a correct workflow, which is its own kind of
      useless guard.
    */
    expect(job).not.toMatch(/^ {4}if:/m);
    expect(job).not.toMatch(/^ {4}continue-on-error:/m);
    // `continue-on-error` on a step turns that step's failure into a pass, so
    // it is refused at every depth rather than only at the job's.
    expect(job).not.toMatch(/^\s+continue-on-error:/m);
  });
});
