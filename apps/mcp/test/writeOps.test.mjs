// The write op `ws.write.wrote` (`src/workspaceStore/writeOps.js`): a file's new etag and size on its live row, answered
// NOT_FOUND for a missing path, a folder or a row that will not take it; refusals for a body that is not a write.
import { test } from "node:test";
import assert from "node:assert/strict";

import { WRITE_OPS, WriteOpRefused } from "../src/workspaceStore/writeOps.js";
import { idKeyFor } from "../src/store/noteIdKeys.js";

const wrote = WRITE_OPS["ws.write.wrote"];
const adopt = WRITE_OPS["ws.write.adopt"];

/** A context with live rows by path, and an `originate` that records what it was asked and answers `at` = now. */
function ctx({ live = {}, refuse = false, now = 1_000 } = {}) {
  const originated = [];
  return {
    originated,
    rows: {
      originate(args, clock) {
        originated.push({ args, clock });
        if (refuse) return null;
        return { id: args.id, at: clock };
      },
    },
    now,
    lookupLive: (path) => live[path] ?? null,
  };
}

const BODY = { workspaceId: "ws_one", path: "1-projects/plan.md", key: "files/n1.md", etag: "e-2", size: 12, at: 999, keyed: false };
const LIVE = { "1-projects/plan.md": { id: "row-1", kind: "file", path: "1-projects/plan.md" } };

test("a write to a live file answers ok with the row's clock, and the change the mirror takes carries it", () => {
  const context = ctx({ live: LIVE });
  const result = wrote(context, BODY);
  assert.deepEqual(result.answer, { ok: true, at: 1_000 });
  assert.equal(result.narrows, false);
  assert.deepEqual(result.change, {
    op: "wrote",
    record: { path: "1-projects/plan.md", key: "files/n1.md", etag: "e-2", size: 12, at: 999, keyed: false },
    objectAt: 1_000,
  });
  assert.deepEqual(context.originated, [{ args: { id: "row-1", fields: { etag: "e-2", size: 12 } }, clock: 1_000 }]);
});

test("objectAt is the row's clock as the row answers it, not the caller's", () => {
  const context = ctx({ live: LIVE, now: 42 });
  const result = wrote(context, { ...BODY, at: 1 });
  assert.equal(result.change.objectAt, 42);
  assert.equal(result.answer.at, 42);
  assert.equal(result.change.record.at, 1, "the caller's own clock is recorded as sent, beside the object's");
});

test("optional fields are left out of the row and the record when they are not given", () => {
  const context = ctx({ live: LIVE });
  const result = wrote(context, { workspaceId: "ws_one", path: "1-projects/plan.md", key: "files/n1.md", etag: "e-3", keyed: true });
  assert.deepEqual(context.originated[0].args.fields, { etag: "e-3" });
  assert.deepEqual(result.change.record, { path: "1-projects/plan.md", key: "files/n1.md", etag: "e-3", keyed: true });
});

test("a keyed write carries its key etag into the record", () => {
  const result = wrote(ctx({ live: LIVE }), { ...BODY, keyed: true, keyEtag: "k-9" });
  assert.equal(result.change.record.keyed, true);
  assert.equal(result.change.record.keyEtag, "k-9");
});

test("a path with no live row is NOT_FOUND, with no change and no row touched", () => {
  const context = ctx({ live: {} });
  assert.deepEqual(wrote(context, BODY), { answer: { ok: false, code: "NOT_FOUND" }, change: null, narrows: false });
  assert.deepEqual(context.originated, []);
});

test("a folder at the path is NOT_FOUND: only a file takes bytes", () => {
  const context = ctx({ live: { "1-projects/plan.md": { id: "f-1", kind: "folder", path: "1-projects/plan.md" } } });
  assert.deepEqual(wrote(context, BODY), { answer: { ok: false, code: "NOT_FOUND" }, change: null, narrows: false });
  assert.deepEqual(context.originated, []);
});

test("a row the object will not change (originate answers null) is NOT_FOUND too", () => {
  const result = wrote(ctx({ live: LIVE, refuse: true }), BODY);
  assert.deepEqual(result, { answer: { ok: false, code: "NOT_FOUND" }, change: null, narrows: false });
});

test("a body that is not a write is refused before any row is looked at", () => {
  const bad = [
    { path: "" },
    { path: "x".repeat(1025) },
    { path: "a\0b" },
    { key: "" },
    { key: 5 },
    { etag: "" },
    { etag: undefined },
    { size: -1 },
    { size: Number.NaN },
    { size: Number.POSITIVE_INFINITY },
    { size: "12" },
    { at: Number.NaN },
    { at: "now" },
    { keyed: "yes" },
    { keyed: undefined },
    { keyEtag: "" },
    { keyEtag: 7 },
  ];
  for (const override of bad) {
    const looked = [];
    const context = ctx({ live: LIVE });
    context.lookupLive = (path) => {
      looked.push(path);
      return LIVE[path];
    };
    assert.throws(() => wrote(context, { ...BODY, ...override }), WriteOpRefused, JSON.stringify(override));
    assert.deepEqual(looked, [], `looked up before refusing ${JSON.stringify(override)}`);
    assert.deepEqual(context.originated, [], `wrote before refusing ${JSON.stringify(override)}`);
  }
});

test("a size of zero is a real size and is kept", () => {
  const result = wrote(ctx({ live: LIVE }), { ...BODY, size: 0 });
  assert.equal(result.change.record.size, 0);
});

// The row moved on to a new storage key since the write was made: the write is the control plane's to judge, so the
// object answers NOT_FOUND and touches nothing. Sabotage, confirmed to fail this case: delete the storageKey check.
test("a write to another key than the live row's is NOT_FOUND, with no change and no row touched", () => {
  const moved = { "1-projects/plan.md": { id: "row-1", kind: "file", path: "1-projects/plan.md", storageKey: "files/n9.md" } };
  const context = ctx({ live: moved });
  assert.deepEqual(wrote(context, BODY), { answer: { ok: false, code: "NOT_FOUND" }, change: null, narrows: false });
  assert.deepEqual(context.originated, []);
});

test("a write to the live row's own storage key still works", () => {
  const keyed = { "1-projects/plan.md": { id: "row-1", kind: "file", path: "1-projects/plan.md", storageKey: "files/n1.md" } };
  const result = wrote(ctx({ live: keyed }), BODY);
  assert.deepEqual(result.answer, { ok: true, at: 1_000 });
  assert.equal(result.change.record.key, "files/n1.md");
});

test("a live row with no storage key (null, or absent) takes a write to any key, as before", () => {
  for (const storageKey of [null, undefined]) {
    const row = { "1-projects/plan.md": { id: "row-1", kind: "file", path: "1-projects/plan.md", storageKey } };
    const result = wrote(ctx({ live: row }), BODY);
    assert.deepEqual(result.answer, { ok: true, at: 1_000 }, String(storageKey));
    assert.equal(result.change.record.key, "files/n1.md");
  }
});

// ---- ws.write.adopt ----------------------------------------------------------------------------------------------------

const NOTE = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f60";
const OTHER_NOTE = "01890a5d-ac97-7c4e-8f3a-1b2c3d4e5f61";
const MINTED = "o_" + "a".repeat(32);
const TEAM_PLANS = { folders: [{ prefix: "plans", visibility: "team" }], notes: [], accessVersion: 4 };
const FOLDER_PLANS = { "plans": { id: "f-plans", kind: "folder", path: "plans" } };

/**
 * An adopt context: live rows by path, live rows by note id, the member rules held (`null` for none), and an
 * `originateNew` that records what it was asked and answers `at` = now.
 */
function adoptCtx({ live = {}, byNote = {}, rules = TEAM_PLANS, now = 2_000 } = {}) {
  const originated = [];
  const seen = { rulesAudiences: [], byNoteIds: [], lookedUp: [] };
  return {
    originated,
    seen,
    rows: {
      originateNew(args, clock) {
        originated.push({ args, clock });
        return { id: args.id, at: clock };
      },
      byNoteId(noteId) {
        seen.byNoteIds.push(noteId);
        return byNote[noteId] ?? null;
      },
      rules(audience) {
        seen.rulesAudiences.push(audience);
        return rules;
      },
    },
    now,
    mintId: () => MINTED,
    lookupLive: (path) => {
      seen.lookedUp.push(path);
      return live[path] ?? null;
    },
  };
}

/** A plain adoption that is taken here: a `team` note in the `plans` folder, which is live, with rules making it team. */
const ADOPT = { path: "plans/a.md", noteId: NOTE, key: idKeyFor(NOTE, "plans/a.md"), etag: "e-1", size: 7, at: 1_500, tier: "team" };

/** Asserts an adoption is deferred to the control plane: DEFER, no change, and no row made. */
function assertDeferred(context, body, label = JSON.stringify(body)) {
  const result = adopt(context, body);
  // Why rides beside the code, a short word for the gateway's log and never the path.
  assert.match(result.answer?.reason ?? "", /^[a-z_]+$/, label);
  assert.deepEqual(result, { answer: { ok: false, code: "DEFER", reason: result.answer.reason }, change: null, narrows: false }, label);
  assert.deepEqual(context.originated, [], `made a row before deferring: ${label}`);
}

test("an adoption of a plain new note is taken: the row is made at the object's clock under the minted id, and the change says so", () => {
  const context = adoptCtx({ live: FOLDER_PLANS });
  const result = adopt(context, ADOPT);
  assert.deepEqual(result.answer, { ok: true, adopted: true, at: 2_000 });
  assert.equal(result.narrows, false);
  assert.deepEqual(result.change, {
    op: "adopt",
    record: { path: "plans/a.md", noteId: NOTE, key: idKeyFor(NOTE, "plans/a.md"), etag: "e-1", size: 7, at: 1_500, objectId: MINTED },
    objectAt: 2_000,
  });
  assert.deepEqual(context.originated, [
    {
      args: { id: MINTED, noteId: NOTE, path: "plans/a.md", kind: "file", storageKey: idKeyFor(NOTE, "plans/a.md"), etag: "e-1", size: 7 },
      clock: 2_000,
    },
  ]);
});

test("the row made by an adoption is a file whose storage key is the note's key, whatever the writer's clock", () => {
  const context = adoptCtx({ live: FOLDER_PLANS, now: 77 });
  adopt(context, { ...ADOPT, at: 1 });
  const [{ args, clock }] = context.originated;
  assert.equal(args.kind, "file");
  assert.equal(args.storageKey, `notes/${NOTE}.md`);
  assert.equal(args.id, MINTED, "the id is the minted one, not the note id");
  assert.equal(clock, 77);
});

test("an adoption without a size leaves the size off the row and the record", () => {
  const context = adoptCtx({ live: FOLDER_PLANS });
  const { size: _size, ...withoutSize } = ADOPT;
  const result = adopt(context, withoutSize);
  assert.equal(result.answer.adopted, true);
  assert.equal("size" in context.originated[0].args, false);
  assert.equal("size" in result.change.record, false);
});

test("an adoption at a root path needs no folder; a private tier is taken where the rules hold the default private", () => {
  const context = adoptCtx({ live: {}, rules: { folders: [], notes: [], accessVersion: 1 } });
  const result = adopt(context, { ...ADOPT, path: "a.md", key: idKeyFor(NOTE, "a.md"), tier: "private" });
  assert.deepEqual(result.answer, { ok: true, adopted: true, at: 2_000 });
  assert.equal(context.originated[0].args.path, "a.md");
});

test("a private tier is adopted where the note's own override holds it private, even under a team folder", () => {
  const rules = { folders: [{ prefix: "plans", visibility: "team" }], notes: [{ path: "plans/a.md", visibility: "private" }], accessVersion: 5 };
  const result = adopt(adoptCtx({ live: FOLDER_PLANS, rules }), { ...ADOPT, tier: "private" });
  assert.deepEqual(result.answer, { ok: true, adopted: true, at: 2_000 });
});

test("a team tier is adopted where the rules hold the note private (narrower here is fine)", () => {
  const rules = { folders: [], notes: [], accessVersion: 1 };
  const result = adopt(adoptCtx({ live: FOLDER_PLANS, rules }), { ...ADOPT, tier: "team" });
  assert.deepEqual(result.answer, { ok: true, adopted: true, at: 2_000 });
});

test("a key that is not the path's id key is DEFER: the control plane's key (a Tex home's, say) is not taken here", () => {
  const cases = [
    { ...ADOPT, key: `files/${NOTE}.md` },
    { ...ADOPT, key: `notes/${OTHER_NOTE}.md` },
    { ...ADOPT, key: `tex/w1/notes/${NOTE}.md` },
    { ...ADOPT, key: idKeyFor(NOTE, "plans/a.pdf") },
  ];
  for (const body of cases) assertDeferred(adoptCtx({ live: FOLDER_PLANS }), body, body.key);
});

test("plumbing paths are DEFER, even with a valid id key", () => {
  for (const path of [".context/x.md", "plans/.hidden/a.md"]) {
    const body = { ...ADOPT, path, key: idKeyFor(NOTE, path) };
    assertDeferred(adoptCtx({ live: { ...FOLDER_PLANS, ".context": { id: "f-c", kind: "folder", path: ".context" } } }), body, path);
  }
});

test("a parent folder that is not live is DEFER: standing up folders is not done here", () => {
  assertDeferred(adoptCtx({ live: {} }), ADOPT, "no folder row");
});

test("a parent that is a file, not a folder, is DEFER", () => {
  const live = { plans: { id: "f-x", kind: "file", path: "plans" } };
  assertDeferred(adoptCtx({ live }), ADOPT, "parent is a file");
});

test("a path already live is DEFER: a name taken is the control plane's to name", () => {
  const live = { ...FOLDER_PLANS, "plans/a.md": { id: "row-9", kind: "file", path: "plans/a.md" } };
  assertDeferred(adoptCtx({ live }), ADOPT, "path live");
  const folderAtPath = { ...FOLDER_PLANS, "plans/a.md": { id: "f-9", kind: "folder", path: "plans/a.md" } };
  assertDeferred(adoptCtx({ live: folderAtPath }), ADOPT, "folder at the path");
});

test("a note id held by a live row is DEFER, whatever its path", () => {
  const byNote = { [NOTE]: { id: "row-3", kind: "file", path: "elsewhere/b.md", noteId: NOTE } };
  assertDeferred(adoptCtx({ live: FOLDER_PLANS, byNote }), ADOPT, "note id held");
});

test("no rules held here is DEFER: the object cannot judge the tier, so the control plane adopts it", () => {
  assertDeferred(adoptCtx({ live: FOLDER_PLANS, rules: null }), ADOPT, "rules null");
});

test("a private tier where the held rules make the path team is DEFER: no reader here may see it before its narrowing", () => {
  assertDeferred(adoptCtx({ live: FOLDER_PLANS, rules: TEAM_PLANS }), { ...ADOPT, tier: "private" }, "private under team folder");
  const teamOverride = { folders: [], notes: [{ path: "plans/a.md", visibility: "team" }], accessVersion: 2 };
  assertDeferred(adoptCtx({ live: FOLDER_PLANS, rules: teamOverride }), { ...ADOPT, tier: "private" }, "private, note held team");
});

test("the rules are read for the member audience, and the id and path checks run before the rules are read", () => {
  const context = adoptCtx({ live: FOLDER_PLANS });
  adopt(context, ADOPT);
  assert.deepEqual(context.seen.rulesAudiences, ["member"]);
  const deferred = adoptCtx({ live: FOLDER_PLANS });
  assertDeferred(deferred, { ...ADOPT, key: "files/x.md" }, "bad key");
  assert.deepEqual(deferred.seen.rulesAudiences, [], "a key mismatch is judged before the rules are read");
});

test("a body that is not an adoption is refused before any row is looked at or made", () => {
  const bad = [
    { path: "" },
    { path: "a".repeat(1025) },
    { path: "a\0b" },
    { path: undefined },
    { noteId: "01890a5d-ac96-4c4e-8f3a-1b2c3d4e5f60" },
    { noteId: "01890A5D-AC96-7C4E-8F3A-1B2C3D4E5F60" },
    { noteId: "not-a-note-id" },
    { noteId: undefined },
    { key: "" },
    { key: 5 },
    { etag: "" },
    { etag: undefined },
    { size: -1 },
    { size: Number.NaN },
    { size: "7" },
    { at: Number.NaN },
    { at: Number.POSITIVE_INFINITY },
    { at: undefined },
    { at: "now" },
    { tier: undefined },
    { tier: "public" },
    { tier: "" },
    { tier: null },
  ];
  for (const override of bad) {
    const context = adoptCtx({ live: FOLDER_PLANS });
    assert.throws(() => adopt(context, { ...ADOPT, ...override }), WriteOpRefused, JSON.stringify(override));
    assert.deepEqual(context.seen.lookedUp, [], `looked up before refusing ${JSON.stringify(override)}`);
    assert.deepEqual(context.originated, [], `made a row before refusing ${JSON.stringify(override)}`);
  }
});

test("a note id that is a UUIDv4, or lacks its id shape, is refused (the id must be a UUIDv7)", () => {
  for (const noteId of ["01890a5d-ac96-4c4e-8f3a-1b2c3d4e5f60", "01890a5dac967c4e8f3a1b2c3d4e5f60", ""]) {
    const context = adoptCtx({ live: FOLDER_PLANS });
    assert.throws(() => adopt(context, { ...ADOPT, noteId }), WriteOpRefused, noteId);
    assert.deepEqual(context.originated, []);
  }
});
