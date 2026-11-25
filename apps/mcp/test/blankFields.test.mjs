/**
 * A FIELD LEFT BLANK IS NOT GIVEN. Grok fills every field a tool shows it, sending `""` (and `false` for a flag) for
 * each one it means to leave out (Dev2's Socials bot, 2026-11-25: `url: ""` beside its logo's `data`, then
 * `content: ""` beside edits, `text: ""` beside a mail join, `owner: ""` beside a change). Each blank below used to refuse the call
 * or change its meaning; each is now read as absent, only where a blank can mean nothing else.
 *
 * `advertised.js` `coercedArguments` (`blankIsAbsent`), `v2/translate.js` `liftAddressing`, `v2/actions.js`
 * `withNote`/`filledMail`, `v2/searchFetch.js` `openArgs`, `notes/writePart.js` `withoutBlankPart`; set_area's blank
 * owner is in `setArea.test.mjs`.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-25):
 *  1. `blankIsAbsent` returning false → "a blank mailbox, person_said...", "a blank where only a list..." fail.
 *  2. `withNote` setting every top-level field again → "a blank content beside args.content..." fails.
 *  3. `filledMail` returning its args → "text: \"\" beside a join..." fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { coercedArguments } from "../src/tools/advertised.js";
import { translateV2Params } from "../src/tools/v2/translate.js";
import { withoutBlankPart } from "../src/tools/notes/writePart.js";
import { mightWiden } from "../src/privacy/egress.js";

const APP = { app: { client: "grok" } };
const v2 = (name, args) => translateV2Params({ name, arguments: args }, undefined, APP);
/** What routing sees: the v2 call translated, then read as the tool's own advertised types. */
const routed = (name, args) => {
  const out = v2(name, args);
  assert.equal(out.error, undefined, out.error);
  return { name: out.params.name, args: coercedArguments(out.params.name, out.params.arguments) };
};

test("a blank mailbox, person_said or expected_etag is not given; a blank context is kept, for routing to refuse", () => {
  const { args } = routed("write", { mailbox: "", person_said: "", action: "", path: "a.md", content: "hi", expected_etag: "" });
  assert.deepEqual(args, { path: "a.md", content: "hi" });
  // Serving the connected workspace for context: "" is the quiet wrong-workspace write (`crossContext/orientation.test.mjs`).
  assert.equal(routed("write", { context: "", path: "a.md", content: "hi" }).args.context, "");
  assert.equal(routed("write", { action: "mail", path: "m.md", args: { text: "hi", context: "" } }).args.context, "");
  const move = routed("manage", { action: "move", args: { source: "a.md", destination: "b.md", destination_context: "" } });
  assert.equal(move.args.destination_context, "");
});

test("a blank where only a list, a flag or a named choice fits is absent, and no longer looks like sharing", () => {
  const visibility = routed("manage", { action: "visibility", args: { path: "a.md", visibility: "private", people: "" } });
  assert.deepEqual(visibility.args, { path: "a.md", visibility: "private" });
  assert.equal(mightWiden(visibility.name, visibility.args), false);
  assert.deepEqual(coercedArguments("orient", { tools: "", about: "", since: "", area: "areas/x", for: "" }), { about: "", area: "areas/x", for: "" });
  assert.deepEqual(coercedArguments("write_note", { path: "a.md", section: "Plan", insert: "", content: "x" }), { path: "a.md", section: "Plan", content: "x" });
});

test("a blank that can mean something is kept: a note emptied, a required choice still refused by its schema", () => {
  assert.deepEqual(routed("write", { path: "a.md", content: "" }).args, { path: "a.md", content: "" });
  assert.equal(coercedArguments("remember", { fact: "x", kind: "" }).kind, "");
});

test("a blank content beside args.content does not replace it, and a blank path names nothing", () => {
  const { name, args } = routed("write", { action: "save_session", path: "", content: "", expected_etag: "", args: { content: "what we decided", platform: "grok" } });
  assert.equal(name, "save_context");
  assert.deepEqual(args, { content: "what we decided", platform: "grok" });
});

test("content: \"\" beside edits, and a blank section, are the fields left empty", () => {
  const { args } = routed("write", { path: "a.md", content: "", expected_etag: "", args: { edits: [{ old: "a", new: "b" }], section: "" } });
  assert.deepEqual(withoutBlankPart(args), { path: "a.md", edits: [{ old: "a", new: "b" }] });
  // Content alone, blank, is still an emptied note.
  assert.deepEqual(withoutBlankPart({ path: "a.md", content: "" }), { path: "a.md", content: "" });
});

test("text: \"\" beside a join is a join, and a mailbox written inside args reaches routing", () => {
  const join = routed("write", { action: "mail", path: "m.md", content: "", expected_etag: "", args: { join: "socials", text: "", to: "", kind: "", mailbox: "" } });
  assert.deepEqual(join.args, { path: "m.md", mail: { join: "socials" } });
  const send = routed("write", { action: "mail", path: "m.md", args: { text: "hi", mailbox: "mb_1" } });
  assert.deepEqual(send.args, { path: "m.md", mail: { text: "hi" }, mailbox: "mb_1" });
  // Named twice, differently, is still refused rather than guessed at.
  assert.match(v2("write", { action: "mail", path: "m.md", mailbox: "mb_1", args: { text: "hi", mailbox: "mb_2" } }).error, /two different values for mailbox/);
});

test("search and fetch read blank and false args as not given", () => {
  const search = routed("search", { query: "Socials", args: { prefix: "", from: "", to: "", email: false, texts: false } });
  assert.deepEqual([search.name, search.args], ["search_notes", { query: "Socials" }]);
  const mail = routed("fetch", { id: "m.md", args: { mail: true, section: "", lines: "", outline: false, full: false, mailbox: "" } });
  assert.deepEqual([mail.name, mail.args], ["read_note", { path: "m.md", mail: true }]);
});
