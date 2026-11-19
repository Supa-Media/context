/**
 * A `context://` link is the `@name/path` sugar, read the same way.
 *
 * Tex writes its notes as `context://@workspace/path.md` and people paste those
 * links back into a call. Before this, the scheme was not stripped, so the path
 * never opened with `@name/` and the call ran in the caller's own context, where
 * it came back "In @john: not found". A link must address exactly as the sugar
 * does, and it must add no reach: whatever a refusal or a traversal check says
 * about `@john/…` it says about `context://@john/…`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressByPath } from "../src/tools/pathAddress.js";
import { normalizePath } from "../src/notes/paths.js";

test("a context:// link opens a path the way the @name/ sugar does", () => {
  const link = { path: "context://@john/inbox/meetings/2026-10-02-john-mateo.md" };
  assert.equal(addressByPath("read_note", link), undefined);
  assert.equal(link.context, "@john");
  assert.equal(link.path, "inbox/meetings/2026-10-02-john-mateo.md");

  const sugar = { path: "@john/inbox/meetings/2026-10-02-john-mateo.md" };
  addressByPath("read_note", sugar);
  assert.deepEqual(link, sugar, "the link and the sugar leave the same arguments");
});

test("the note/ route segment after the scheme is read as the link it is", () => {
  const args = { path: "context://note/@john/inbox/a.md" };
  assert.equal(addressByPath("read_note", args), undefined);
  assert.equal(args.context, "@john");
  assert.equal(args.path, "inbox/a.md");
});

test("a link without a name is a plain path in the caller's own context", () => {
  const args = { path: "context://note/inbox/a.md" };
  assert.equal(addressByPath("read_note", args), undefined);
  assert.equal(args.context, undefined, "no name, so no workspace is routed to");
  assert.equal(args.path, "inbox/a.md");
});

test("move_note reads a link on each side as its own context", () => {
  const args = {
    source: "context://@john/inbox/a.md",
    destination: "context://note/@band/archive/a.md",
  };
  assert.equal(addressByPath("move_note", args), undefined);
  assert.equal(args.source_context, "@john");
  assert.equal(args.source, "inbox/a.md");
  assert.equal(args.destination_context, "@band");
  assert.equal(args.destination, "archive/a.md");
});

test("a link agrees with a context argument that names the same workspace", () => {
  const args = { context: "@john", path: "context://@john/inbox/a.md" };
  assert.equal(addressByPath("read_note", args), undefined);
  assert.equal(args.context, "@john");
  assert.equal(args.path, "inbox/a.md");
});

test("a link naming a different workspace than context is refused, never read in either", () => {
  const args = { context: "@band", path: "context://@john/a.md" };
  const refusal = addressByPath("read_note", args);
  assert.equal(typeof refusal, "string");
  assert.match(refusal, /names two workspaces/);
  assert.match(refusal, /@john/);
  assert.match(refusal, /@band/);
});

test("no new reach: a traversal in a link is refused exactly as it is in the sugar form", () => {
  const link = { path: "context://@john/../../x" };
  const sugar = { path: "@john/../../x" };
  addressByPath("read_note", link);
  addressByPath("read_note", sugar);
  assert.deepEqual(link, sugar);
  assert.equal(link.context, "@john", "the traversal stays inside @john's routing, not the caller's own");
  assert.equal(normalizePath("../../x"), null, "the downstream normaliser refuses the `..` segments");
});

test("a percent-encoded traversal in a link is refused downstream too", () => {
  const link = { path: "context://@john/%2e%2e/%2e%2e/x" };
  addressByPath("read_note", link);
  assert.equal(normalizePath(link.path), null);
});

test("a context:// that is not at the start of a path is left alone", () => {
  const args = { path: "inbox/see context://@john/a.md" };
  assert.equal(addressByPath("read_note", args), undefined);
  assert.equal(args.path, "inbox/see context://@john/a.md");
  assert.equal(args.context, undefined);

  const nested = { path: "notes/context://@john/a.md" };
  addressByPath("read_note", nested);
  assert.equal(nested.path, "notes/context://@john/a.md");
  assert.equal(nested.context, undefined);
});

test("an absent path argument is not created by the link check", () => {
  const args = { context: "@john" };
  addressByPath("read_note", args);
  assert.deepEqual(args, { context: "@john" });
});
