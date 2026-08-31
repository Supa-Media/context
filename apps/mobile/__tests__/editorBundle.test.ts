/**
 * THE COMMITTED BUNDLE IS THE CODE IN THIS REPOSITORY.
 *
 * `bundle.generated.ts` holds the iOS editor as one minified script, built by
 * `scripts/build-editor-bundle.mjs`. That is the only way an offline app with a
 * pinned `runtimeVersion` can ship a DOM library — see the script for the
 * argument — and it has exactly one failure mode, which is that somebody edits
 * `livePreview.ts`, runs the suite, sees green, and ships a phone build running
 * last month's editor.
 *
 * There is nothing subtle about catching it. The generator records a SHA-256 of
 * every repository file that went into the bundle and the resolved version of
 * every package that did, both read out of esbuild's own metafile rather than
 * from a list somebody maintains. This recomputes both.
 *
 * It deliberately does **not** run esbuild. Rebuilding here would make the
 * check depend on a bundler that is not a declared dependency of this app, and
 * would turn "you forgot to rebuild" into a slow test rather than a fast
 * message. The point is to fail with the command to run.
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
});
