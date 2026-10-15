/**
 * A note's website flags travel in the tree's facts (`propsOf`), so a public
 * list asks the tree whether a page still publishes rather than opening it.
 * The flags must be as strict as the text check they replace: a value the
 * parser would reject is a restriction, never consent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { propsOf } from "../src/tree/props.js";
import { siteFlagsOf, websiteTextRestricts } from "../src/tree/siteFlags.js";

const SEALED = "---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{\"v\":1,\"ciphertext\":\"0000\"}\n```\n";

test("a plain public page neither restricts nor drafts", () => {
  assert.deepEqual(siteFlagsOf("---\ntitle: About\n---\n\nHi\n"), { draft: false, restricts: false });
  assert.deepEqual(siteFlagsOf("No front matter at all\n"), { draft: false, restricts: false });
  assert.deepEqual(siteFlagsOf("---\naudience: public\ndraft: false\n---\n"), { draft: false, restricts: false });
});

test("audience other than public restricts, but is not a draft", () => {
  assert.deepEqual(siteFlagsOf("---\naudience: members\n---\n"), { draft: false, restricts: true });
});

test("a draft restricts and is a draft, whatever value it carries", () => {
  assert.deepEqual(siteFlagsOf("---\ndraft: true\n---\n"), { draft: true, restricts: true });
  // A lone key, which noteProperties drops, and a value the parser rejects.
  assert.deepEqual(siteFlagsOf("---\ndraft\n---\n"), { draft: true, restricts: true });
  assert.deepEqual(siteFlagsOf("---\ndraft: maybe\n---\n"), { draft: true, restricts: true });
});

test("an unclosed front matter block still counts", () => {
  assert.deepEqual(siteFlagsOf("---\naudience: members\ntitle: Half typed\n"), { draft: false, restricts: true });
});

test("a sealed note restricts", () => {
  assert.equal(websiteTextRestricts(SEALED), true);
});

test("propsOf carries the flags, and a lone draft key survives as one", () => {
  const props = propsOf("---\ntitle: Post\ndraft\n---\n\n# Post\n");
  assert.deepEqual(props.site, { draft: true, restricts: true });
  assert.equal("draft" in props.properties, false);
  assert.deepEqual(propsOf("---\ntitle: Post\n---\n").site, { draft: false, restricts: false });
  assert.equal(propsOf(SEALED), null);
});
