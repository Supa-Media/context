/**
 * NAMED PHASES INSIDE A SAVE (`src/tools/notes/write.js`, `src/mcp/phase.js`).
 *
 * `toolWriteNote` wraps each awaited section in `phase(store, name, run)`, and
 * the store's `phase` (laid by `mcpRoute.js`'s equip) times it as
 * `phase:<name>` in the MCP entry point. A store without `phase` must save
 * exactly as before: the helper just runs the section.
 *
 * Sabotage: drop one `phase(...)` wrapper in write.js and the order test for
 * that name fails; make `phase()` swallow `run` and the content tests fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { laySavePhase, phase, phaseTimer } from "../src/mcp/phase.js";
import { mcpEntry } from "../src/mcp/mcpEntryPoint.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const FOLDER = { prefix: "notes", visibility: "team" };
const FOLDER_RULE = { prefix: "notes", vis: "team" };
const PRIVATE_NOTE = "notes/private.md";
const NEW_NOTE = "notes/new.md";

/** The same rows-mode harness as `writeKeepsTier.test.mjs`. */
function harness({ phases } = {}) {
  const store = withPrivacyAuthority(withServedTree(createMemoryStore()), {
    rules: {
      etag: "rows-v1",
      accessVersion: 1,
      folders: [FOLDER],
      notes: [{ path: PRIVATE_NOTE, visibility: "private" }],
    },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  if (phases) {
    Object.defineProperty(store, "phase", {
      value: (name, run) => {
        phases.push(name);
        return run();
      },
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  const overrides = new PrivacyOverrides();
  overrides.set(PRIVATE_NOTE, "private");
  return { store, overrides };
}

async function save(store, overrides, args, scope = "private") {
  return toolWriteNote(store, scope, [FOLDER_RULE], overrides, args);
}

/** Each expected name must appear, and in the order given, within the names recorded. */
function assertInOrder(names, expected) {
  let at = -1;
  for (const name of expected) {
    const index = names.indexOf(name, at + 1);
    assert.ok(index > at, `${name} must be recorded in order; got ${names.join(", ")}`);
    at = index;
  }
}

test("saving an existing note records its phases in order", async () => {
  const phases = [];
  const { store, overrides } = harness({ phases });
  await store.put(PRIVATE_NOTE, "# Private\n");
  const etag = (await store.get(PRIVATE_NOTE)).etag;
  const result = await save(store, overrides, {
    path: PRIVATE_NOTE,
    content: "# Private\n\nedited\n",
    expected_etag: etag,
  });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assertInOrder(phases, ["write_find", "write_load", "write_put", "write_record"]);
});

test("creating a new note records its phases in order", async () => {
  const phases = [];
  const { store, overrides } = harness({ phases });
  const result = await save(store, overrides, { path: NEW_NOTE, content: "# New\n", visibility: "private" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assertInOrder(phases, ["write_names", "write_tier", "write_put", "write_record"]);
});

test("a store without phase still saves, and the note is what was sent", async () => {
  const { store, overrides } = harness();
  const result = await save(store, overrides, { path: NEW_NOTE, content: "# Plain\n", visibility: "private" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.equal(await (await store.get(NEW_NOTE)).text(), "# Plain\n");
});

test("phase() runs the section untimed when the store has no phase, and returns its value", async () => {
  assert.equal(await phase({}, "write_put", async () => 7), 7);
  assert.equal(await phase(undefined, "write_put", () => "x"), "x");
});

test("phaseTimer records phase:<name> through the MCP entry point's step", async () => {
  const mcp = mcpEntry({});
  const timed = phaseTimer(mcp);
  assert.equal(await timed("write_find", async () => "found"), "found");
  assert.equal(await timed("write_put", () => "put"), "put");
  assert.deepEqual(
    mcp.points.map((point) => [point.name, point.state]),
    [["phase:write_find", "ok"], ["phase:write_put", "ok"]],
  );
});

test("phaseTimer runs an invalid name untimed", async () => {
  const mcp = mcpEntry({});
  const timed = phaseTimer(mcp);
  for (const bad of ["Write_Find", "write-find", "", "x".repeat(41), "write find", "write1"]) {
    assert.equal(await timed(bad, () => "ran"), "ran", `run still happens for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(mcp.points, [], "no point is recorded for an invalid name");
});

test("phaseTimer records a failed section as failed and rethrows", async () => {
  const mcp = mcpEntry({});
  const timed = phaseTimer(mcp);
  await assert.rejects(timed("write_put", async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(mcp.points.map((point) => [point.name, point.state]), [["phase:write_put", "failed"]]);
});

test("laySavePhase lays phase once, non-enumerable and read-only, and it times through the entry point", async () => {
  const mcp = mcpEntry({});
  const store = mcp.watch({ get: async () => null, put: async () => ({ etag: "e" }) });
  assert.equal(laySavePhase(store, mcp), store);
  assert.equal(laySavePhase(store, mcp), store, "a second lay is a no-op, not a throw");
  assert.equal(Object.keys(store).includes("phase"), false, "phase is not enumerable");
  assert.equal(Object.getOwnPropertyDescriptor(store, "phase").writable, false);
  assert.equal(await phase(store, "write_put", () => "done"), "done");
  assert.deepEqual(mcp.points.map((point) => point.name), ["phase:write_put"]);
});
