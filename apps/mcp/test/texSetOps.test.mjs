/**
 * The edits to one Training or Dev test conversation (`packages/shared/src/texSetOps.cjs`; Dev2, 2026-11-15: "make sure
 * that through the MCP it's easy for an agent to see and modify and change training, dev sets"). The Lab's Testing tab,
 * the control plane's `texSets.ts` and `tex_dev` all apply these, so the rules are pinned here once: every op, the
 * Lab's own spellings (addMsg, editMsg, removeMsg, moveMsg, label), the Test Set refused, the batch all-or-nothing, and
 * the conflict keys that let two people label different cells at once.
 *
 * Sabotage record (temporary edits to texSetOps.cjs, restored from a byte-identical backup, 2026-11-15):
 *   applyOps working on the input, not a clone      "applyOps is all or nothing ..." fails
 *   makeTex keeping labels on a Tex row             "edit who to Tex drops its labels ..." and "add of a new speaker ..." fail
 *   overlaps: whole-node vs field only when equal   "a whole-node label conflicts with its field, either way round" fails
 *   MAX_OPS raised from 200 to 500                  "a batch needs a list of ops, and is at most MAX_OPS long" fails
 *   add with after null putting the message last    "add with no after appends; after null puts it first" and
 *                                                   "the Lab's addMsg adds at an index ..." fail
 *   add joining a trigger row to members (11-16)    "adding a trigger row ... never makes it a member" fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ops = require("../../../packages/shared/src/texSetOps.cjs");
const { applyOps, apply, blank, conflicts, keysOf, describe, MAX_OPS, OpError, OPEN_SETS } = ops;

/** A small dev conversation: a person, Tex's row, a person again. */
const base = () => ({
  id: "chat-one",
  title: "Chat",
  set: "dev",
  kind: "one",
  members: ["Jo"],
  msgs: [
    { id: "m1", who: "Jo", text: "is the bin out?" },
    { id: "m2", who: "Tex", tex: true, text: "yes, it went out this morning" },
    { id: "m3", who: "Jo", text: "thanks" },
  ],
});
const ids = (c) => c.msgs.map((m) => m.id);
const run = (convo, list) => applyOps(convo, list).convo;

test("title trims the name and refuses an empty one or a non-text", () => {
  assert.equal(run(base(), [{ op: "title", value: "  Bins  " }]).title, "Bins");
  assert.throws(() => run(base(), [{ op: "title", value: "   " }]), /a chat needs a title/);
  assert.throws(() => run(base(), [{ op: "title", value: 3 }]), /title is text/);
});

test("kind is one or group and nothing else", () => {
  assert.equal(run(base(), [{ op: "kind", value: "group" }]).kind, "group");
  assert.equal(run(base(), [{ op: "kind", value: "one" }]).kind, "one");
  assert.throws(() => run(base(), [{ op: "kind", value: "crowd" }]), /kind is "one"/);
});

test("members are trimmed, de-duplicated, and never Tex", () => {
  assert.deepEqual(run(base(), [{ op: "members", value: [" Jo ", "Ann", "Jo"] }]).members, ["Jo", "Ann"]);
  assert.throws(() => run(base(), [{ op: "members", value: ["Tex"] }]), /Tex is never a member/);
  assert.throws(() => run(base(), [{ op: "members", value: ["  "] }]), /members is a list of names/);
});

test("set moves a conversation between training and dev; the test set is refused with the reason", () => {
  assert.deepEqual(OPEN_SETS, ["training", "dev"]);
  assert.equal(run(base(), [{ op: "set", value: "training" }]).set, "training");
  assert.throws(() => run(base(), [{ op: "set", value: "test" }]), /the Test Set is people only/);
  assert.throws(() => run(base(), [{ op: "set", value: "gold" }]), /set is "training" or "dev"/);
});

test("add with no after appends; after null puts it first; after a message puts it just past that one", () => {
  assert.deepEqual(ids(run(base(), [{ op: "add", msg: { who: "Jo", text: "last" } }])), ["m1", "m2", "m3", "m4"]);
  assert.deepEqual(ids(run(base(), [{ op: "add", after: null, msg: { id: "x1", who: "Jo", text: "first" } }])), ["x1", "m1", "m2", "m3"]);
  assert.deepEqual(ids(run(base(), [{ op: "add", after: "m1", msg: { id: "x2", who: "Jo", text: "mid" } }])), ["m1", "x2", "m2", "m3"]);
});

test("add gives a fresh id, refuses a repeated or badly shaped id, a message with no speaker, and an unknown after", () => {
  const c = run(base(), [{ op: "add", msg: { who: "Jo", text: "x" } }]);
  assert.equal(c.msgs.at(-1).id, "m4");
  assert.throws(() => run(base(), [{ op: "add", msg: { id: "m1", who: "Jo", text: "again" } }]), /already a message "m1"/);
  assert.throws(() => run(base(), [{ op: "add", msg: { id: "bad id!", who: "Jo", text: "x" } }]), /must be letters, digits/);
  assert.throws(() => run(base(), [{ op: "add", msg: { text: "nobody" } }]), /needs who said it/);
  assert.throws(() => run(base(), [{ op: "add", after: "zz", msg: { who: "Jo", text: "x" } }]), /there is no message "zz"/);
});

test("add of a new speaker makes them a member; a Tex row keeps no labels", () => {
  const c = run(base(), [{ op: "add", msg: { who: "Ann", text: "hi" } }]);
  assert.deepEqual(c.members, ["Jo", "Ann"]);
  const t = run(base(), [{ op: "add", msg: { who: "Tex", text: "ok", labels: { decide: { act: "respond" } } } }]);
  assert.equal(t.msgs.at(-1).tex, true);
  assert.equal(t.msgs.at(-1).labels, undefined);
  assert.deepEqual(t.members, ["Jo"]);
});

test("edit who to Tex makes a Tex row and drops its labels, its recorded runs and its star", () => {
  const start = base();
  start.msgs[0].labels = { decide: { act: "respond", star: true } };
  start.msgs[0].rec = { fd: { draft: "x" } };
  const c = run(start, [{ op: "edit", msg: "m1", field: "who", value: "Tex" }]);
  assert.equal(c.msgs[0].who, "Tex");
  assert.equal(c.msgs[0].tex, true);
  assert.equal(c.msgs[0].labels, undefined);
  assert.equal(c.msgs[0].rec, undefined);
  assert.equal(c.msgs[0].star, undefined);
});

test("edit who from Tex to a name makes a person's message and joins them", () => {
  const c = run(base(), [{ op: "edit", msg: "m2", field: "who", value: "Ann" }]);
  assert.equal(c.msgs[1].tex, undefined);
  assert.equal(c.msgs[1].who, "Ann");
  assert.deepEqual(c.members, ["Jo", "Ann"]);
});

test("edit kind react points it at the message before, and refuses on the first message", () => {
  const c = run(base(), [{ op: "edit", msg: "m3", field: "kind", value: "react" }]);
  assert.equal(c.msgs[2].kind, "react");
  assert.equal(c.msgs[2].to, "m2");
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "kind", value: "react" }]), /the first/);
  assert.throws(() => run(base(), [{ op: "edit", msg: "m3", field: "kind", value: "poke" }]), /kind is one of react, reply, edit, delete/);
});

test("edit kind delete empties the text; kind null makes a plain text again and drops the pointer", () => {
  const d = run(base(), [{ op: "edit", msg: "m3", field: "kind", value: "delete" }]);
  assert.equal(d.msgs[2].kind, "delete");
  assert.equal(d.msgs[2].text, "");
  const plain = run(d, [{ op: "edit", msg: "m3", field: "kind", value: null }]);
  assert.equal(plain.msgs[2].kind, undefined);
  assert.equal(plain.msgs[2].to, undefined);
});

test("edit to points at an earlier message; a later one or itself is refused", () => {
  const c = run(base(), [{ op: "edit", msg: "m3", field: "to", value: "m1" }]);
  assert.equal(c.msgs[2].to, "m1");
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "to", value: "m3" }]), /points at an earlier message/);
  assert.throws(() => run(base(), [{ op: "edit", msg: "m2", field: "to", value: "m2" }]), /points at an earlier message/);
});

test("edit text replaces the words; a non-text is refused; an unknown field names the fields", () => {
  assert.equal(run(base(), [{ op: "edit", msg: "m1", field: "text", value: "is the bin out yet?" }]).msgs[0].text, "is the bin out yet?");
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "text", value: 4 }]), /text is text/);
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "colour", value: "red" }]), /a message's fields are/);
});

test("remove takes a message out; an unknown one is refused", () => {
  assert.deepEqual(ids(run(base(), [{ op: "remove", msg: "m2" }])), ["m1", "m3"]);
  assert.throws(() => run(base(), [{ op: "remove", msg: "m9" }]), /no message "m9"/);
});

test("move puts a message just before another, or last with before null", () => {
  assert.deepEqual(ids(run(base(), [{ op: "move", msg: "m3", before: "m1" }])), ["m3", "m1", "m2"]);
  assert.deepEqual(ids(run(base(), [{ op: "move", msg: "m1", before: null }])), ["m2", "m3", "m1"]);
  assert.deepEqual(ids(run(base(), [{ op: "move", msg: "m1", before: "m3" }])), ["m2", "m1", "m3"]);
  assert.throws(() => run(base(), [{ op: "move", msg: "m1", before: "zz" }]), /no message "zz"/);
});

test("label sets a node's whole label on a person's message; null or an empty one drops it", () => {
  const c = run(base(), [{ op: "label", msg: "m1", node: "decide", value: { act: "respond", why: "asked" } }]);
  assert.deepEqual(c.msgs[0].labels, { decide: { act: "respond", why: "asked" } });
  assert.equal(run(c, [{ op: "label", msg: "m1", node: "decide", value: null }]).msgs[0].labels, undefined);
  assert.equal(run(c, [{ op: "label", msg: "m1", node: "decide", value: {} }]).msgs[0].labels, undefined);
  assert.throws(() => run(base(), [{ op: "label", msg: "m1", node: "decide", value: ["act"] }]), /takes value: an object/);
  assert.throws(() => run(base(), [{ op: "label", msg: "m2", node: "decide", value: { act: "respond" } }]), /Tex row/);
  assert.throws(() => run(base(), [{ op: "label", msg: "m1", node: "not a node", value: { act: "x" } }]), /config id/);
});

test("field sets one field of a label; star true makes a unit test; star false, \"as main\", null and \"\" drop the field", () => {
  let c = run(base(), [{ op: "field", msg: "m1", node: "decide", field: "act", value: "respond" }]);
  assert.deepEqual(c.msgs[0].labels, { decide: { act: "respond" } });
  c = run(c, [{ op: "field", msg: "m1", node: "decide", field: "star", value: true }]);
  assert.equal(c.msgs[0].labels.decide.star, true);
  c = run(c, [{ op: "field", msg: "m1", node: "decide", field: "star", value: false }]);
  assert.equal(c.msgs[0].labels.decide.star, undefined);
  assert.deepEqual(c.msgs[0].labels, { decide: { act: "respond" } });
  for (const dropped of ["as main", null, ""]) {
    const d = run(c, [{ op: "field", msg: "m1", node: "decide", field: "act", value: dropped }]);
    assert.equal(d.msgs[0].labels, undefined, `dropping with ${JSON.stringify(dropped)} empties the label`);
  }
});

test("field refuses a message with no field name and a Tex row", () => {
  assert.throws(() => run(base(), [{ op: "field", msg: "m1", node: "decide", field: "", value: "x" }]), /field names the label's field/);
  assert.throws(() => run(base(), [{ op: "field", msg: "m2", node: "decide", field: "act", value: "x" }]), /Tex row/);
});

test("rec sets a node's recorded run on main on a person's message; null drops it; a Tex row refuses it", () => {
  const c = run(base(), [{ op: "rec", msg: "m1", node: "fd", value: { draft: "Hi", did: [] } }]);
  assert.deepEqual(c.msgs[0].rec, { fd: { draft: "Hi", did: [] } });
  assert.equal(run(c, [{ op: "rec", msg: "m1", node: "fd", value: null }]).msgs[0].rec, undefined);
  assert.throws(() => run(base(), [{ op: "rec", msg: "m2", node: "fd", value: { draft: "x" } }]), /Tex row/);
});

test("put replaces the whole conversation but keeps its id, and refuses another id or the test set", () => {
  const next = { ...base(), title: "Whole new", msgs: [{ id: "q1", who: "Ann", text: "hello" }], members: ["Ann"] };
  const c = run(base(), [{ op: "put", convo: next }]);
  assert.equal(c.id, "chat-one");
  assert.equal(c.title, "Whole new");
  assert.deepEqual(ids(c), ["q1"]);
  assert.throws(() => run(base(), [{ op: "put", convo: { ...next, id: "other" } }]), /put keeps the conversation's id \(chat-one\)/);
  assert.throws(() => run(base(), [{ op: "put", convo: { ...next, set: "test" } }]), /never written here/);
});

test("the Lab's addMsg adds at an index: 0 first, past the end last, otherwise after the one before it", () => {
  assert.deepEqual(ids(run(base(), [{ op: "addMsg", at: 0, msg: { id: "a", who: "Jo", text: "x" } }])), ["a", "m1", "m2", "m3"]);
  assert.deepEqual(ids(run(base(), [{ op: "addMsg", at: 1, msg: { id: "b", who: "Jo", text: "x" } }])), ["m1", "b", "m2", "m3"]);
  assert.deepEqual(ids(run(base(), [{ op: "addMsg", at: 99, msg: { id: "c", who: "Jo", text: "x" } }])), ["m1", "m2", "m3", "c"]);
  assert.deepEqual(ids(run(base(), [{ msg: { id: "d", who: "Jo", text: "x" }, op: "addMsg" }])), ["m1", "m2", "m3", "d"]);
});

test("the Lab's editMsg patches fields as edits: who first, a Tex flag, and a patch of several", () => {
  const c = run(base(), [{ op: "editMsg", id: "m1", patch: { who: "Ann", text: "bin?" } }]);
  assert.equal(c.msgs[0].who, "Ann");
  assert.equal(c.msgs[0].text, "bin?");
  assert.deepEqual(c.members, ["Jo", "Ann"]);
  assert.equal(run(base(), [{ op: "editMsg", id: "m1", patch: { tex: true } }]).msgs[0].tex, true);
  const person = run(base(), [{ op: "editMsg", id: "m2", patch: { tex: false, who: "Jo" } }]);
  assert.equal(person.msgs[1].tex, undefined);
  assert.equal(person.msgs[1].who, "Jo");
  assert.throws(() => run(base(), [{ op: "editMsg", id: "m1", patch: {} }]), /editMsg takes patch/);
});

test("the Lab's removeMsg and moveMsg: moveMsg at an index (past the end is last)", () => {
  assert.deepEqual(ids(run(base(), [{ op: "removeMsg", id: "m2" }])), ["m1", "m3"]);
  assert.deepEqual(ids(run(base(), [{ op: "moveMsg", id: "m1", at: 0 }])), ["m1", "m2", "m3"]);
  assert.deepEqual(ids(run(base(), [{ op: "moveMsg", id: "m3", at: 0 }])), ["m3", "m1", "m2"]);
  assert.deepEqual(ids(run(base(), [{ op: "moveMsg", id: "m1", at: 2 }])), ["m2", "m3", "m1"]);
  assert.deepEqual(ids(run(base(), [{ op: "moveMsg", id: "m1", at: 50 }])), ["m2", "m3", "m1"]);
});

test("the Lab's label takes its label as the value: { id, node, label }", () => {
  const c = run(base(), [{ op: "label", id: "m1", node: "decide", label: { act: "wait" } }]);
  assert.deepEqual(c.msgs[0].labels, { decide: { act: "wait" } });
  assert.equal(run(c, [{ op: "label", id: "m1", node: "decide", label: null }]).msgs[0].labels, undefined);
});

test("the test set is refused by set, by put, and by blank", () => {
  assert.throws(() => apply(base(), { op: "set", value: "test" }), OpError);
  assert.throws(() => apply(base(), { op: "put", convo: { ...base(), set: "test" } }), /never written here/);
  assert.throws(() => blank({ id: "new-one", set: "test" }), /never written here/);
  assert.deepEqual(blank({ id: "new-one" }), { id: "new-one", title: "New chat", set: "dev", kind: "one", members: ["Jo"], msgs: [] });
});

test("applyOps is all or nothing: a bad second edit leaves the input unchanged and names edit 2", () => {
  const input = base();
  const before = JSON.stringify(input);
  let caught = null;
  try {
    applyOps(input, [{ op: "title", value: "Renamed" }, { op: "remove", msg: "nope" }]);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof OpError, "the batch throws an OpError");
  assert.match(caught.message, /^edit 2 \(remove\)/);
  assert.equal(JSON.stringify(input), before, "the input conversation is untouched");
});

test("applyOps names the edit that could not be applied and returns keys, said and full for a good batch", () => {
  const out = applyOps(base(), [{ op: "title", value: "Bins" }, { op: "label", msg: "m1", node: "decide", value: { act: "respond" } }]);
  assert.equal(out.convo.title, "Bins");
  assert.deepEqual(out.keys.sort(), ["l:m1:decide", "title"]);
  assert.deepEqual(out.said, ['renamed the chat "Bins"', "labelled decide on m1: {\"act\":\"respond\"}"]);
  assert.equal(out.full.length, 2);
});

test("a batch needs a list of ops, and is at most MAX_OPS long", () => {
  assert.equal(MAX_OPS, 200);
  assert.throws(() => applyOps(base(), []), /ops is a list of edits/);
  assert.throws(() => applyOps(base(), "title"), /ops is a list of edits/);
  const many = Array.from({ length: MAX_OPS + 1 }, () => ({ op: "title", value: "x" }));
  assert.throws(() => applyOps(base(), many), /at most 200 edits at once/);
  assert.equal(applyOps(base(), many.slice(0, MAX_OPS)).convo.title, "x");
});

// Found by this file's first draft (2026-11-15): move spliced the message out before looking up `before`.
test("moving a message before itself leaves it where it is; before a missing one is refused", () => {
  const c = base();
  const ids = c.msgs.map((m) => m.id);
  assert.deepEqual(applyOps(c, [{ op: "move", msg: ids[0], before: ids[0] }]).convo.msgs.map((m) => m.id), ids);
  assert.throws(() => applyOps(c, [{ op: "move", msg: ids[0], before: "nope" }]), /no message "nope"/);
});

test("an unknown op names the ops there are", () => {
  assert.throws(() => applyOps(base(), [{ op: "teleport" }]), /there is no edit "teleport"/);
  assert.throws(() => applyOps(base(), [null]), /an edit is an object with an op/);
});

test("keysOf names the piece each edit touches", () => {
  assert.deepEqual(keysOf({ op: "title" }), ["title"]);
  assert.deepEqual(keysOf({ op: "remove", msg: "m1" }), ["order", "m:m1"]);
  assert.deepEqual(keysOf({ op: "move", msg: "m1" }), ["order"]);
  assert.deepEqual(keysOf({ op: "field", msg: "m1", node: "decide", field: "act" }), ["l:m1:decide:act"]);
  assert.deepEqual(keysOf({ op: "rec", msg: "m1", node: "fd" }), ["r:m1:fd"]);
  assert.deepEqual(keysOf({ op: "put" }), ["*"]);
});

test("same label field conflicts; different fields on one node do not", () => {
  const a = keysOf({ op: "field", msg: "m1", node: "decide", field: "act" });
  assert.deepEqual(conflicts(a, keysOf({ op: "field", msg: "m1", node: "decide", field: "act" })), a);
  assert.deepEqual(conflicts(a, keysOf({ op: "field", msg: "m1", node: "decide", field: "why" })), []);
});

test("a whole-node label conflicts with its field, either way round", () => {
  const whole = keysOf({ op: "label", msg: "m1", node: "decide", value: {} });
  const field = keysOf({ op: "field", msg: "m1", node: "decide", field: "act" });
  assert.equal(conflicts(whole, field).length, 1);
  assert.equal(conflicts(field, whole).length, 1);
});

test("removing a message conflicts with labels on it; editing it conflicts with them too", () => {
  const removal = keysOf({ op: "remove", msg: "m1" });
  const label = keysOf({ op: "label", msg: "m1", node: "decide", value: {} });
  assert.equal(conflicts(removal, label).length, 1);
  assert.equal(conflicts(keysOf({ op: "edit", msg: "m1", field: "text", value: "x" }), label).length, 1);
  assert.equal(conflicts(keysOf({ op: "rec", msg: "m1", node: "fd" }), removal).length, 1);
});

test("different messages do not conflict, nor do two labels on different messages", () => {
  assert.deepEqual(conflicts(keysOf({ op: "edit", msg: "m1", field: "text", value: "x" }), keysOf({ op: "edit", msg: "m2", field: "text", value: "y" })), []);
  assert.deepEqual(conflicts(keysOf({ op: "field", msg: "m1", node: "decide", field: "act" }), keysOf({ op: "field", msg: "m2", node: "decide", field: "act" })), []);
});

test("a whole conversation (put) conflicts with every edit, and two titles conflict", () => {
  assert.equal(conflicts(keysOf({ op: "put" }), keysOf({ op: "label", msg: "m9", node: "decide", value: {} })).length, 1);
  assert.equal(conflicts(keysOf({ op: "title" }), keysOf({ op: "title" })).length, 1);
});

test("describe keeps a short line, and the full one when asked", () => {
  const long = "x".repeat(200);
  const line = describe({ op: "edit", msg: "m1", field: "text", value: long });
  assert.ok(line.length < 100 && line.endsWith("…"));
  assert.ok(describe({ op: "edit", msg: "m1", field: "text", value: long }, true).length > 200);
  assert.equal(describe({ op: "field", msg: "m1", node: "decide", field: "star", value: false }), "unstarred decide on m1");
});

// Dev2, 2026-11-16: "No way to add images into these messages".
test("a message carries pictures: https only, at most MAX_PICS, null drops them, and a picture needs no words", () => {
  const { MAX_PICS } = ops;
  const { check } = require("../../../packages/shared/src/texSets.cjs");
  const pic = { url: "https://example.invalid/a.png", type: "image/png", name: "a.png" };
  const c = run(base(), [{ op: "edit", msg: "m1", field: "pics", value: [pic] }]);
  assert.deepEqual(c.msgs[0].pics, [pic]);
  assert.match(describe({ op: "edit", msg: "m1", field: "pics", value: [pic] }), /1 picture/);
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "pics", value: [{ url: "http://example.invalid/a.png" }] }]), OpError);
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "pics", value: [{ url: "https://x.invalid/a", type: "text/html" }] }]), OpError);
  assert.throws(() => run(base(), [{ op: "edit", msg: "m1", field: "pics", value: Array(MAX_PICS + 1).fill(pic) }]), OpError);
  assert.equal(run(c, [{ op: "edit", msg: "m1", field: "pics", value: null }]).msgs[0].pics, undefined);
  const only = run(c, [{ op: "edit", msg: "m1", field: "text", value: "" }]);
  assert.ok(!check(only, { nodes: [] }).some((p) => /no words/.test(p)), "a picture with no words is a sound message");
  const added = run(base(), [{ op: "add", msg: { who: base().members[0], text: "", pics: [pic] } }]);
  assert.deepEqual(added.msgs.at(-1).pics, [pic]);
});

test("adding a trigger row (check-in, routine) never makes it a member", () => {
  const out = run(base(), [{ op: "add", msg: { who: "Check-in", via: "checkin", text: "Gmail: the boiler visit moved to Friday" } }]);
  assert.ok(!out.members.includes("Check-in"));
  assert.equal(out.msgs.at(-1).via, "checkin");
});
