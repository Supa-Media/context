// A write under `routines/` tells the control plane which paths moved and
// who wrote them, so it can re-read the folder and run each routine as its
// writer (`docs/decisions/routines.md`). Paths and an id, never text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { announceRoutineChange, MAX_ROUTINE_PATHS } from "../src/activity/record.js";
import { createReportingMethods } from "../src/controlPlane/reporting.js";

function fakeStore(userId = "user_writer") {
  const reports = [];
  return {
    reports,
    actor: { userId },
    reportRoutineChange: (paths, who) => reports.push({ paths, who }),
  };
}

test("only routine paths are reported, with the writer", () => {
  const store = fakeStore();
  announceRoutineChange(store, ["1-projects/a.md", "/routines/daily/brief.md", "routines-old/x.md"]);
  assert.deepEqual(store.reports, [{ paths: ["routines/daily/brief.md"], who: "user_writer" }]);
});

test("a move reports both ends when either is a routine, and a folder counts", () => {
  const store = fakeStore();
  announceRoutineChange(store, ["routines/daily/brief.md", "4-archive/brief.md"]);
  announceRoutineChange(store, ["routines"]);
  assert.deepEqual(store.reports.map((r) => r.paths), [["routines/daily/brief.md"], ["routines"]]);
});

test("a write elsewhere says nothing", () => {
  const store = fakeStore();
  announceRoutineChange(store, ["website/index.md", "privacy.md"]);
  announceRoutineChange(store, "routines/daily/x.md");
  assert.equal(store.reports.length, 0);
});

test("a report is bounded", () => {
  const store = fakeStore();
  const many = Array.from({ length: MAX_ROUTINE_PATHS + 10 }, (_, i) => `routines/daily/r${i}.md`);
  announceRoutineChange(store, many);
  assert.equal(store.reports[0].paths.length, MAX_ROUTINE_PATHS);
});

test("the wire carries the workspace, the writer and the paths, and nothing else", async () => {
  const sent = [];
  const methods = createReportingMethods({ post: async (route, body) => sent.push({ route, body }) });
  await methods.reportRoutineChange("ws_1", "user_writer", ["routines/daily/brief.md"]);
  await methods.reportRoutineChange("ws_1", null, ["routines/daily/brief.md"]);
  await methods.reportRoutineChange("ws_1", "user_writer", []);
  assert.deepEqual(sent, [
    { route: "/gateway/routines", body: { workspaceId: "ws_1", userId: "user_writer", paths: ["routines/daily/brief.md"] } },
    { route: "/gateway/routines", body: { workspaceId: "ws_1", paths: ["routines/daily/brief.md"] } },
  ]);
});

// Routines' new home (the owner, 2026-10-14): a write under `tex/routines/`
// is reported like one under `routines/`, and so is a move or deletion of the
// `tex` folder, which takes that root with it. A note beside it is not.
// Sabotage, 2026-10-14: `announceRoutineChange` matching only `routines/`
// again fails both tests below.
test("a write under tex/routines/ is reported, with the writer", () => {
  const store = fakeStore();
  announceRoutineChange(store, ["tex/routines/daily/x.md", "tex/about-me.md", "1-projects/tex/routines/daily/x.md"]);
  assert.deepEqual(store.reports, [{ paths: ["tex/routines/daily/x.md"], who: "user_writer" }]);
});

test("a move between the two roots reports both ends, and the tex folder counts", () => {
  const store = fakeStore();
  announceRoutineChange(store, ["routines/daily/x.md", "tex/routines/daily/x.md"]);
  announceRoutineChange(store, ["tex", "4-archive/tex"]);
  assert.deepEqual(store.reports.map((r) => r.paths), [["routines/daily/x.md", "tex/routines/daily/x.md"], ["tex"]]);
});
