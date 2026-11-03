// The write op `ws.write.wrote` (`src/workspaceStore/writeOps.js`): a file's new etag and size on its live row, answered
// NOT_FOUND for a missing path, a folder or a row that will not take it; refusals for a body that is not a write.
import { test } from "node:test";
import assert from "node:assert/strict";

import { WRITE_OPS, WriteOpRefused } from "../src/workspaceStore/writeOps.js";

const wrote = WRITE_OPS["ws.write.wrote"];

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
