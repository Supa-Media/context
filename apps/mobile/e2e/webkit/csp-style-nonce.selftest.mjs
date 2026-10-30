import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { freshNonce, NONCED_STYLE_IDS, policyWithNonce, withStyleNonce } from "./csp-style-nonce.mjs";

const SHELL = readFileSync(join(import.meta.dirname, "..", "..", "public", "index.html"), "utf8");

test("every nonce is new, and 128 bits", () => {
  const seen = new Set(Array.from({ length: 1000 }, freshNonce));
  assert.equal(seen.size, 1000);
  for (const nonce of seen) assert.equal(Buffer.from(nonce, "base64").length, 16);
});

test("the real shell's two inline styles get the nonce, and nothing else does", () => {
  const nonce = freshNonce();
  const html = withStyleNonce(SHELL, nonce);
  assert.equal(html.split(`nonce="${nonce}"`).length - 1, NONCED_STYLE_IDS.length);
  assert.doesNotMatch(html, /<script[^>]*nonce=/);
});

test("a shell without one of the styles is refused, not served without a nonce", () => {
  assert.throws(() => withStyleNonce(SHELL.replace('<style id="context-ground">', "<style>"), "x"));
});

test("only style-src gains the nonce", () => {
  const policy = "default-src 'self'; script-src 'self' 'sha256-a'; style-src 'self' 'sha256-b'; report-uri /_csp-report";
  assert.equal(
    policyWithNonce(policy, "Tk9OQ0U="),
    "default-src 'self'; script-src 'self' 'sha256-a'; style-src 'self' 'sha256-b' 'nonce-Tk9OQ0U='; report-uri /_csp-report",
  );
  assert.equal(policyWithNonce("frame-ancestors 'self'; object-src 'none'", "x"), "frame-ancestors 'self'; object-src 'none'");
});

test("a style-src that allows 'unsafe-inline' is refused, because a nonce would switch it off", () => {
  assert.throws(() => policyWithNonce("style-src 'self' 'unsafe-inline'", "x"), /unsafe-inline/);
});
