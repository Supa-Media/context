/**
 * A recorded change re-checks the Convex tree by name (`/gateway/tree/touch`).
 *
 * `recordChange` is the one call every gateway write makes afterwards. A change
 * that moves the tree's shape names the paths it touched; the control plane's
 * copy of the tree is re-checked from those names. Names only, never text, and
 * more than 50 of them is not sent at all: the control plane is told the tree
 * is dirty and sweeps it instead.
 *
 * Sabotage-checked: dropping the `reportTreeTouch` call from `announceTreeChange`
 * fails the recorded-change checks; dropping the `dirty` branch fails the
 * 51-name check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReportingMethods } from "../src/controlPlane/reporting.js";
import { recordChange } from "../src/activity/record.js";

/** A control-plane `post` that records each call and answers `ok`. */
function controlPlaneRecorder() {
  const calls = [];
  const methods = createReportingMethods({
    post: async (path, body) => {
      calls.push({ path, body });
      return { ok: true };
    },
  });
  return { calls, methods };
}

/**
 * The store a write's `recordChange` needs, with the one reporter under test
 * bound the way `attachChangeReporters` binds it (`src/http/route.js`).
 */
function storeWith(methods, workspaceId) {
  const deferred = [];
  const store = {
    put: async () => {},
    defer: (work) => {
      deferred.push(work);
    },
    reportTreeTouch: (touch) => methods.reportTreeTouch(workspaceId, touch).catch(() => {}),
  };
  return {
    store,
    settle: () => Promise.all(deferred),
  };
}

test("a touch names its paths and files, and carries no text", async () => {
  const { calls, methods } = controlPlaneRecorder();
  await methods.reportTreeTouch("ws_touch", { paths: ["1-projects/a.md"], files: ["0-inbox/b.md"] });
  assert.deepEqual(calls, [
    {
      path: "/gateway/tree/touch",
      body: { workspaceId: "ws_touch", paths: ["1-projects/a.md"], files: ["0-inbox/b.md"], dirty: false },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["dirty", "files", "paths", "workspaceId"]);
});

test("exactly 50 names is still sent by name; 51 sends dirty with no names", async () => {
  const { calls, methods } = controlPlaneRecorder();
  const fifty = Array.from({ length: 50 }, (_, index) => `1-projects/n${index}.md`);
  await methods.reportTreeTouch("ws_touch", { paths: fifty, files: [] });
  assert.equal(calls[0].body.dirty, false);
  assert.equal(calls[0].body.paths.length, 50);

  calls.length = 0;
  const fiftyOne = Array.from({ length: 51 }, (_, index) => `1-projects/n${index}.md`);
  await methods.reportTreeTouch("ws_touch", { paths: fiftyOne, files: [] });
  assert.deepEqual(calls[0].body, { workspaceId: "ws_touch", paths: [], files: [], dirty: true });

  calls.length = 0;
  const manyFiles = Array.from({ length: 51 }, (_, index) => `0-inbox/f${index}.md`);
  await methods.reportTreeTouch("ws_touch", { paths: ["a.md"], files: manyFiles });
  assert.deepEqual(calls[0].body, { workspaceId: "ws_touch", paths: [], files: [], dirty: true });
});

test("a recorded move re-checks the tree by the paths it named", async () => {
  const { calls, methods } = controlPlaneRecorder();
  const { store, settle } = storeWith(methods, "ws_recorded");
  await recordChange(store, "move_note", "private", ["1-projects/a.md", "2-areas/a.md"], {});
  await settle();
  const touches = calls.filter((call) => call.path === "/gateway/tree/touch");
  assert.equal(touches.length, 1, "a move of one note was not reported to the tree");
  assert.equal(touches[0].body.workspaceId, "ws_recorded");
  assert.deepEqual(touches[0].body.paths, ["1-projects/a.md", "2-areas/a.md"]);
  assert.equal(touches[0].body.dirty, false);
});

test("a recorded change naming more than 50 paths is reported dirty", async () => {
  const { calls, methods } = controlPlaneRecorder();
  const { store, settle } = storeWith(methods, "ws_recorded");
  const many = Array.from({ length: 60 }, (_, index) => `1-projects/m${index}.md`);
  await recordChange(store, "move_notes", "private", many, {});
  await settle();
  const touches = calls.filter((call) => call.path === "/gateway/tree/touch");
  assert.equal(touches.length, 1);
  assert.deepEqual(touches[0].body, { workspaceId: "ws_recorded", paths: [], files: [], dirty: true });
});

test("a change that moves nothing in the tree is not reported as a touch", async () => {
  const { calls, methods } = controlPlaneRecorder();
  const { store, settle } = storeWith(methods, "ws_recorded");
  await recordChange(store, "update_note", "private", ["1-projects/a.md"], {});
  await settle();
  assert.equal(calls.filter((call) => call.path === "/gateway/tree/touch").length, 0);
});

test("a visibility change names privacy.md, because that is the file it rewrote", async () => {
  // The control plane keeps a mirror of the rules and refreshes it only when a
  // touch names `privacy.md` (`lib/nodes/touch.ts`). `set_visibility` writes
  // that file and records the *note's* path, so without this the mirror keeps
  // the old rules until a sweep — and a listing served from the mirror would
  // go on showing a name the owner just took back.
  for (const action of ["set_visibility", "set_folder_visibility"]) {
    const { calls, methods } = controlPlaneRecorder();
    const { store, settle } = storeWith(methods, "ws_recorded");
    await recordChange(store, action, "private", ["1-projects/a.md"], {});
    await settle();
    const touches = calls.filter((call) => call.path === "/gateway/tree/touch");
    assert.equal(touches.length, 1, `${action} was not reported to the tree`);
    assert.deepEqual(touches[0].body.paths, ["1-projects/a.md"], action);
    assert.deepEqual(touches[0].body.files, ["privacy.md"], `${action} did not name privacy.md`);
    assert.equal(touches[0].body.dirty, false);
  }
});

test("a change that did not rewrite privacy.md does not name it", async () => {
  const { calls, methods } = controlPlaneRecorder();
  const { store, settle } = storeWith(methods, "ws_recorded");
  await recordChange(store, "move_note", "private", ["1-projects/a.md", "2-areas/a.md"], {});
  await settle();
  const touches = calls.filter((call) => call.path === "/gateway/tree/touch");
  assert.deepEqual(touches[0].body.files, []);
});
