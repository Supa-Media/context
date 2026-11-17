/**
 * `tex_dev`'s actions on Tex's Training and Dev conversations (`src/texDev/sets.js`, through `createTexDev` in
 * `src/texDev/tool.js`; Dev2, 2026-11-15: "make sure that through the MCP it's easy for an agent to see and modify and
 * change training, dev sets"). The repo's conversations are read with the Lab's drafts over them; every write goes to
 * the control plane, which is faked here. Pinned: what each call sends, what each answer says, the Test Set refused
 * before anything is sent, a repo conversation's first edit carrying its base, the copy check on an imported chat, and
 * that the tool's description and guide name every set action.
 *
 * Sabotage record (temporary local edits to src/texDev/sets.js, restored from a byte-identical backup, 2026-11-15):
 *   overlay ignoring a draft over a repo copy       "sets lists ... and a draft overrides its repo copy" fails
 *   set_edit sending the repo copy as base anyway   "with a draft, set_edit sends no base" fails
 *   set_edit's test-set check dropped               "set_edit with op set test is refused ... without calling" fails
 *   COPY_RUN raised from 6 to 8                     "copiesOf flags a line sharing six words ..." and
 *                                                   "set_create with from_chat refuses a copy ..." fail
 *   set_create from_chat copy check skipped         "set_create with from_chat refuses a copy ..." fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createTexDev } from "../src/texDev/tool.js";
import { guideText } from "../src/texDev/guide.js";
import { copiesOf, sourceTexts } from "../src/texDev/sets.js";
import { texDevToolDefinitions } from "../src/tools/schemas/texDev.js";
import { WHY } from "../../../packages/shared/src/textDecide.cjs";

const require = createRequire(import.meta.url);
const REPO = require("../../../packages/shared/src/texSetsRepo.generated.json");
const { ratio, unitTests } = require("../../../packages/shared/src/texSets.cjs");

const session = { accessToken: "tok" };
const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));
const clone = (v) => JSON.parse(JSON.stringify(v));
const repoDev = () => clone(REPO.sets.find((c) => c.set === "dev"));

/** A fake control plane: answers by action (a value, or a function of the args). */
function fakePlane(answers) {
  const calls = [];
  return {
    calls,
    async texDev(token, action, args) {
      calls.push({ token, action, args });
      const a = answers[action];
      return typeof a === "function" ? a(args) : (a ?? null);
    },
  };
}

const EMPTY_DRAFTS = { set_drafts: { status: "ok", drafts: [] } };

/** The tool for one connection. `extra` carries `ledgerOf` for the chat reads. */
function tool(answers = {}, extra = {}) {
  const plane = fakePlane({ ...EMPTY_DRAFTS, ...answers });
  const call = createTexDev({ env: { APP_ORIGIN: "https://context.example" }, session, controlPlane: plane, ...extra });
  return { plane, call };
}

const draftOf = (convo, rev, extra = {}) => ({ id: convo.id, set: convo.set, conv: JSON.stringify(convo), rev, by: "@jo", via: "lab", at: 1, isNew: false, removed: false, promote: null, ...extra });

/** A Tex page with one person's chat (the one-to-one), and a fake ledger that reads the given texts. */
const PAGE = { status: "ok", workspaceId: "ws-test", timeZone: "UTC", chats: [] };
const ledgerWith = (entries) => ({ ledgerOf: () => ({ read: async () => ({ entries }) }) });
const ROSA_TEXT = { kind: "text", text: "Could you move the Thursday meeting to half past two please?", from: { kind: "person", name: "Rosa" }, at: 1, seq: 1 };

test("sets lists the repo's conversations with the ratio, and a draft overrides its repo copy", async () => {
  const { call } = tool();
  const res = jsonOf(await call("sets", { limit: 500 }));
  assert.equal(res.of, REPO.sets.length);
  assert.equal(res.sets.length, REPO.sets.length);
  const expected = ratio(REPO.sets);
  assert.equal(res.ratio.training, expected.counts.training);
  assert.equal(res.ratio.dev, expected.counts.dev);
  assert.match(res.ratio.test, /never shown here/);

  const dev = repoDev();
  const mine = { ...dev, title: "Mine now" };
  const drafted = tool({ set_drafts: { status: "ok", drafts: [draftOf(mine, 3)] } });
  const after = jsonOf(await drafted.call("sets", { limit: 500 }));
  const row = after.sets.find((s) => s.id === dev.id);
  assert.equal(row.title, "Mine now", "the draft's title is what the list shows");
  assert.deepEqual(row.draft, { rev: 3, by: "@jo", via: "lab" });
  assert.equal(after.of, REPO.sets.length, "a draft over a repo conversation is not a new row");
});

test("a removed draft leaves its conversation out of the ratio, and a new draft adds a row", async () => {
  const dev = repoDev();
  const gone = tool({ set_drafts: { status: "ok", drafts: [draftOf(dev, 2, { removed: true })] } });
  const res = jsonOf(await gone.call("sets", { limit: 500 }));
  assert.equal(res.of, REPO.sets.length, "a removed conversation is still listed for its mark");
  assert.equal(res.sets.find((s) => s.id === dev.id).draft.removed, true);
  const withoutIt = ratio(REPO.sets.filter((c) => c.id !== dev.id));
  assert.equal(res.ratio.dev, withoutIt.counts.dev);
  assert.equal(res.ratio.training, withoutIt.counts.training);

  const fresh = { id: "brand-new-chat", title: "New", set: "training", kind: "one", members: ["Ann"], msgs: [] };
  const added = jsonOf(await tool({ set_drafts: { status: "ok", drafts: [draftOf(fresh, 1, { isNew: true })] } }).call("sets", { limit: 500 }));
  assert.equal(added.of, REPO.sets.length + 1);
  assert.equal(added.sets.find((s) => s.id === "brand-new-chat").draft.isNew, true);
});

test("sets refuses the Test Set before it asks the control plane anything", async () => {
  const { plane, call } = tool();
  const res = await call("sets", { set: "test" });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Test Set is people only/);
  assert.equal(plane.calls.length, 0);
});

test("set_get: an unknown id is refused; a known one answers its problems and its unit tests", async () => {
  const { call } = tool();
  const unknown = await call("set_get", { id: "no-such-chat" });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /There is no Training or Dev conversation no-such-chat/);
  assert.equal((await call("set_get", { id: "Not An Id" })).isError, true);

  const dev = repoDev();
  const got = jsonOf(await call("set_get", { id: dev.id }));
  assert.equal(got.conversation.id, dev.id);
  assert.equal(got.rev, 0);
  assert.equal(got.draft, null);
  assert.deepEqual(got.problems, []);
  assert.equal(got.unitTests.length, unitTests(dev).length);
});

test("set_edit on a repo conversation with no draft sends the repo copy as base, at revision 0", async () => {
  const dev = repoDev();
  const renamed = { ...dev, title: "Renamed" };
  const { plane, call } = tool({ set_edit: (args) => ({ status: "ok", id: args.id, rev: 1, said: ['renamed the chat "Renamed"'], conv: JSON.stringify(renamed) }) });
  const ops = [{ op: "title", value: "Renamed" }];
  const res = jsonOf(await call("set_edit", { id: dev.id, ops }));
  const sent = plane.calls.find((c) => c.action === "set_edit").args;
  assert.equal(sent.rev, 0);
  assert.deepEqual(sent.base, dev);
  assert.deepEqual(sent.ops, ops);
  assert.deepEqual([res.id, res.rev, res.kept], [dev.id, 1, ['renamed the chat "Renamed"']]);
  assert.deepEqual(res.problems, []);
  assert.match(res.then, /set_promote/);
});

test("with a draft, set_edit sends no base and the draft's revision", async () => {
  const dev = repoDev();
  const { plane, call } = tool({
    set_drafts: { status: "ok", drafts: [draftOf(dev, 4)] },
    set_edit: (args) => ({ status: "ok", id: args.id, rev: args.rev + 1, said: [], conv: JSON.stringify(dev) }),
  });
  const res = jsonOf(await call("set_edit", { id: dev.id, ops: [{ op: "title", value: "Again" }] }));
  const sent = plane.calls.find((c) => c.action === "set_edit").args;
  assert.equal(sent.rev, 4);
  assert.equal("base" in sent, false, "the draft is the base; nothing is sent over it");
  assert.equal(res.rev, 5);
});

test("set_edit with op set test is refused, and so is put of a test conversation, without calling the control plane", async () => {
  const { plane, call } = tool();
  const dev = repoDev();
  const viaSet = await call("set_edit", { id: dev.id, rev: 0, ops: [{ op: "set", value: "test" }] });
  assert.equal(viaSet.isError, true);
  assert.match(textOf(viaSet), /Test Set is people only/);
  const viaPut = await call("set_edit", { id: dev.id, rev: 0, ops: [{ op: "put", convo: { ...dev, set: "test" } }] });
  assert.equal(viaPut.isError, true);
  assert.equal(plane.calls.filter((c) => c.action === "set_edit").length, 0);
});

test("set_edit passes a conflict through as refused, with the pieces and the conversation as it now is", async () => {
  const dev = repoDev();
  const now = { ...dev, title: "Theirs" };
  const { call } = tool({ set_edit: () => ({ status: "conflict", rev: 3, keys: ["m:m1"], conv: JSON.stringify(now), next: "read the conversation again and redo the edit against it" }) });
  const res = jsonOf(await call("set_edit", { id: dev.id, rev: 1, ops: [{ op: "edit", msg: "m1", field: "text", value: "x" }] }));
  assert.match(res.refused, /someone changed the same thing since your revision; nothing was saved/);
  assert.deepEqual(res.pieces, ["m:m1"]);
  assert.equal(res.rev, 3);
  assert.equal(res.now.title, "Theirs");
  assert.match(res.next, /redo the edit/);
});

test("set_move moves a repo conversation between training and dev, and refuses the test set", async () => {
  const dev = repoDev();
  const { plane, call } = tool({ set_edit: (args) => ({ status: "ok", id: args.id, rev: 1, said: ["moved it to Training"], conv: JSON.stringify({ ...dev, set: "training" }) }) });
  const moved = jsonOf(await call("set_move", { id: dev.id, set: "training" }));
  const sent = plane.calls.find((c) => c.action === "set_edit").args;
  assert.deepEqual(sent.ops, [{ op: "set", value: "training" }]);
  assert.deepEqual(sent.base, dev);
  assert.equal(moved.rev, 1);
  const before = plane.calls.length;
  assert.equal((await call("set_move", { id: dev.id, set: "test" })).isError, true);
  assert.equal((await call("set_move", { id: dev.id, set: "gold" })).isError, true);
  assert.equal(plane.calls.length, before, "a refused move asks the control plane nothing");
});

test("set_create with an unsound conversation is refused locally, before the control plane", async () => {
  const { plane, call } = tool();
  const unsound = { id: "new-one", title: "Bad", set: "dev", kind: "one", members: ["Ann"], msgs: [{ id: "m1", who: "Bob", text: "hi" }] };
  const res = await call("set_create", { conv: unsound });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /would not be sound/);
  assert.match(textOf(res), /Bob is not in the chat's members/);
  assert.equal(plane.calls.filter((c) => c.action === "set_create").length, 0);
});

test("set_create with a sound conversation sends the repo's ids so a clash is refused there", async () => {
  const dev = repoDev();
  const { plane, call } = tool({ set_create: { status: "ok", id: "fresh-one", rev: 1, conv: "{}" } });
  const sound = { id: "fresh-one", title: "Fine", set: "training", kind: "one", members: ["Ann"], msgs: [{ id: "m1", who: "Ann", text: "is it on?" }] };
  const res = jsonOf(await call("set_create", { conv: sound }));
  const sent = plane.calls.find((c) => c.action === "set_create").args;
  assert.deepEqual(sent.repoIds, REPO.sets.map((c) => c.id));
  assert.ok(sent.repoIds.includes(dev.id));
  assert.deepEqual([res.id, res.rev], ["fresh-one", 1]);
});

test("set_delete needs confirm: true; a repo conversation goes at the next Promote, with its base", async () => {
  const dev = repoDev();
  const { plane, call } = tool({ set_remove: { status: "ok", id: dev.id, deleted: "at the next Promote" } });
  const first = await call("set_delete", { id: dev.id });
  assert.equal(first.isError, true);
  assert.match(textOf(first), /Send it again with confirm: true/);
  assert.equal(plane.calls.filter((c) => c.action === "set_remove").length, 0);
  const done = jsonOf(await call("set_delete", { id: dev.id, confirm: true }));
  const sent = plane.calls.find((c) => c.action === "set_remove").args;
  assert.equal(sent.id, dev.id);
  assert.deepEqual(sent.base, dev);
  assert.equal(done.deleted, "at the next Promote");
  assert.match(done.undo, /set_restore/);
});

test("set_restore takes the mark back with a restore, not a removal", async () => {
  const { plane, call } = tool({ set_remove: { status: "ok", id: "x" } });
  const res = jsonOf(await call("set_restore", { id: "x" }));
  assert.deepEqual(plane.calls.find((c) => c.action === "set_remove").args, { id: "x", restore: true });
  assert.equal(res.restored, true);
});

// Dev2, 2026-11-16: "please make sure we have a change history and the ability to undo" — the Lab's History, here too.
test("set_history lists the revisions with the repo's copy last, and set_back puts one back", async () => {
  const dev = REPO.sets.find((c) => c.set === "dev");
  const { plane, call } = tool({
    set_history: { status: "ok", id: dev.id, rev: 2, isNew: false, revs: [{ rev: 2, said: ["b"], restorable: true }, { rev: 1, said: ["a"], restorable: true }] },
    set_back: { status: "ok", id: dev.id, rev: 3, conv: JSON.stringify(dev) },
  });
  const h = jsonOf(await call("set_history", { id: dev.id }));
  assert.deepEqual(h.revs.map((r) => r.rev), [2, 1, 0]);
  const back = jsonOf(await call("set_back", { id: dev.id, to: 1 }));
  assert.deepEqual(plane.calls.find((c) => c.action === "set_back").args, { id: dev.id, to: 1 });
  assert.equal(back.rev, 3);
  assert.equal((await call("set_back", { id: dev.id })).isError, true);
});

test("set_promote refuses when a draft has problems, and asks for the sound ones", async () => {
  const bad = { id: "bad-one", title: "Bad", set: "dev", kind: "one", members: ["Maya"], msgs: [{ id: "m1", who: "Bob", text: "hi" }] };
  const ok = { id: "ok-one", title: "Fine", set: "training", kind: "one", members: ["Ann"], msgs: [{ id: "m1", who: "Ann", text: "hi there" }] };
  const drafts = [draftOf(bad, 1, { isNew: true }), draftOf(ok, 1, { isNew: true })];
  const { plane, call } = tool({ set_drafts: { status: "ok", drafts }, set_promote: { status: "ok", asked: ["ok-one"], then: "later" } });
  const refused = await call("set_promote", {});
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /These would be refused: bad-one: message 1: Bob is not in the chat's members/);
  assert.equal(plane.calls.filter((c) => c.action === "set_promote").length, 0);

  const asked = jsonOf(await call("set_promote", { ids: ["ok-one"] }));
  assert.deepEqual(plane.calls.find((c) => c.action === "set_promote").args, { ids: ["ok-one"] });
  assert.deepEqual(asked.asked, ["ok-one"]);
});

test("set_fields lists decide's picks, its why among them, and the edits set_edit takes", async () => {
  const { call } = tool();
  const res = jsonOf(await call("set_fields", { node: "decide" }));
  assert.equal(res.nodes.length, 1);
  assert.equal(res.nodes[0].node, "decide");
  assert.deepEqual(res.nodes[0].picks.act, ["quiet", "respond", "wait"]);
  assert.deepEqual(res.nodes[0].picks.why, Object.keys(WHY));
  assert.match(res.every.star, /unit test/);
  assert.match(res.ops, /set_edit takes up to 200 ops/);
  assert.equal((await call("set_fields", { node: "nowhere" })).isError, true);
});

test("copiesOf flags a line sharing six words in a row with a real text, and a whole short line equal to one", () => {
  const source = [{ who: "Rosa", text: "Could you move the Thursday meeting to half past two please?" }, { who: "Rosa", text: "see you then" }];
  const shared = copiesOf({ msgs: [{ text: "We could really move the Thursday meeting to half past two" }], members: ["Ann"] }, source);
  assert.deepEqual(shared, ["message 1 copies 6 words in a row from a real text"]);
  const whole = copiesOf({ msgs: [{ text: "See you then!" }], members: ["Ann"] }, source);
  assert.deepEqual(whole, ["message 1 is a real text word for word"]);
});

test("copiesOf flags a member named like a real speaker, and passes a rewritten line", () => {
  const source = [{ who: "Rosa", text: "Could you move the Thursday meeting to half past two please?" }, { who: "Tex", tex: true, text: "Sure, I can." }];
  assert.deepEqual(copiesOf({ msgs: [{ text: "Hi there" }], members: ["Rosa"] }, source), ["Rosa is a real person's name in that chat: invent another"]);
  // A line with its own words and a member no real speaker is named as passes.
  assert.deepEqual(copiesOf({ msgs: [{ text: "Could Ann shift the Friday stand-up to quarter past ten" }], members: ["Ann"] }, source), []);
});

// A whole-line copy counts from three words: a short line anyone says ("ok thanks") is never one person's words.
test("copiesOf lets a short everyday line through and flags a three-word one", () => {
  assert.deepEqual(copiesOf({ msgs: [{ text: "ok thanks" }], members: ["Ann"] }, [{ who: "Rosa", text: "ok thanks" }]), []);
  assert.deepEqual(copiesOf({ msgs: [{ text: "ok thanks Rosa" }], members: ["Ann"] }, [{ who: "Rosa", text: "Ok, thanks Rosa!" }]), ["message 1 is a real text word for word"]);
});

test("sourceTexts reads a chat's texts oldest first, named as the chat has them, without seq", async () => {
  const entries = [
    { kind: "text", text: "second", from: { kind: "tex" }, at: 2, seq: 2 },
    { kind: "text", text: "first", from: { kind: "person", name: "Rosa" }, at: 1, seq: 1 },
    { kind: "reply", text: "not a text", at: 3 },
  ];
  const got = await sourceTexts({ APP_ORIGIN: "x" }, PAGE, { chat: "me" }, ledgerWith(entries).ledgerOf);
  assert.deepEqual(got.texts.map((t) => [t.n, t.who, t.text]), [[1, "Rosa", "first"], [2, "Tex", "second"]]);
  assert.equal(got.texts[1].tex, true);
  assert.equal(got.texts[0].seq, 1, "sourceTexts keeps seq; set_import strips it");
});

test("set_create with from_chat refuses a copy of a real text, and saves a rewritten one", async () => {
  const copied = { id: "copy-one", title: "Copy", set: "dev", kind: "one", members: ["Nia"], msgs: [{ id: "m1", who: "Nia", text: "We could really move the Thursday meeting to half past two" }] };
  const rewritten = { id: "rewrite-one", title: "Rewrite", set: "dev", kind: "one", members: ["Nia"], msgs: [{ id: "m1", who: "Nia", text: "Could Nia shift the Friday stand-up to quarter past ten" }] };
  const { plane, call } = tool({ page: PAGE, set_create: { status: "ok", id: "rewrite-one", rev: 1, conv: "{}" } }, ledgerWith([ROSA_TEXT]));
  const refused = await call("set_create", { conv: copied, from_chat: { chat: "me" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /examples from real chats are never verbatim/);
  assert.match(textOf(refused), /copies 6 words in a row/);
  assert.equal(plane.calls.filter((c) => c.action === "set_create").length, 0, "a copy is not created");

  const ok = jsonOf(await call("set_create", { conv: rewritten, from_chat: { chat: "me" } }));
  assert.equal(ok.id, "rewrite-one");
  assert.equal(plane.calls.filter((c) => c.action === "set_create").length, 1);
});

test("set_import hands a chat's texts with the rules, and names set_create as the next step", async () => {
  const { call } = tool({ page: PAGE }, ledgerWith([ROSA_TEXT]));
  const res = jsonOf(await call("set_import", { chat: "me", limit: 5 }));
  assert.equal(res.texts.length, 1);
  assert.equal(res.texts[0].who, "Rosa");
  assert.ok(res.rules.some((r) => /never copy it/.test(r)));
  assert.match(res.next, /set_create \{ conv, from_chat: \{ chat: "me"/);
});

test("the tool's description and the guide name every set action", () => {
  const actions = ["sets", "set_get", "set_fields", "set_edit", "set_move", "set_create", "set_import", "set_delete", "set_restore", "set_history", "set_back", "set_ratio", "set_promote"];
  const description = texDevToolDefinitions()[0].description;
  const guide = guideText();
  for (const action of actions) {
    assert.match(description, new RegExp(`\\b${action}\\b`), `the description names ${action}`);
    assert.match(guide, new RegExp(`- ${action} `), `the guide names ${action}`);
  }
  assert.match(texDevToolDefinitions()[0].inputSchema.properties.action.description, /set_promote/);
});
