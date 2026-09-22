import assert from "node:assert/strict";
import test from "node:test";
import { eligible as publicEligible } from "../src/index.js";
import { eligible as pureEligible, eligibleForStorageStamp } from "../src/eligibility.js";

test("the dependency-free predicate backs the public collaboration export", () => {
  const cases = [
    ["normal.md", "text", true],
    ["", "text", false],
    ["/absolute.md", "text", false],
    ["folder//note.md", "text", false],
    [".context/note.md", "text", false],
    ["privacy.md", "text", false],
    ["drawing.excalidraw.md", "text", false],
    ["drawing.excalidraw.json", "text", false],
    ["encrypted.md", "---\ncontext_encryption: v1\n---\nbody", false],
    ["bom.md", "\ufeff---\ncontext_encryption: v1\n---\nbody", false],
    ["frontmatter.md", "---\ntitle: context_encryption: v1\n---\nbody", true],
  ];
  for (const [path, text, expected] of cases) {
    assert.equal(pureEligible(path, text), expected, `pure predicate: ${path}`);
    assert.equal(publicEligible(path, text), expected, `public predicate: ${path}`);
  }
  assert.equal(pureEligible("privacy.md", "manifest"), false);
  assert.equal(eligibleForStorageStamp("privacy.md", "manifest"), true);
});
