// Routines have two homes (the owner, 2026-10-14): new ones go in
// `tex/routines/<how-often>/<name>.md`, and every `routines/<how-often>/` note
// keeps running exactly as before, with nothing moved for anyone. The format
// module (`packages/shared/src/routines.cjs`) is the one reading of both, so
// both roots are pinned here, and the old root's answers are pinned again,
// byte for byte, in `routines.test.mjs`, which this change leaves untouched.
//
// Sabotage, 2026-10-14: dropping `tex/routines/` from `ROUTINE_ROOTS` fails
// "both roots are routine roots"; giving the new root the old run-history
// prefix (so `tex/routines/daily/x.md` and `routines/daily/x.md` share
// `.context/agent/routines/daily/x.json`) fails "run history for the two roots
// never collides"; matching the new root case-sensitively only, or the old one
// as a bare substring, fails "only a root at the top of the workspace counts".
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ROUTINES_FOLDER,
  TEX_ROUTINES_FOLDER,
  ROUTINE_ROOTS,
  routineFromPath,
  routineRootOf,
  isRoutinePath,
  routineRunsKey,
  routineSettings,
  nextRunAt,
} = require("../../../packages/shared/src/routines.cjs");

const NY = "America/New_York";

test("both roots are routine roots, the new one first", () => {
  assert.equal(ROUTINES_FOLDER, "routines/");
  assert.equal(TEX_ROUTINES_FOLDER, "tex/routines/");
  assert.deepEqual([...ROUTINE_ROOTS], ["tex/routines/", "routines/"]);
  assert.deepEqual(routineFromPath("tex/routines/daily/x.md"), {
    kind: "routine",
    cadence: { unit: "day", every: 1 },
    folder: "daily",
    name: "x",
  });
  assert.deepEqual(routineFromPath("tex/routines/once/call-sam.md").cadence, { unit: "once", every: 1 });
  assert.equal(routineRootOf("tex/routines/daily/x.md"), "tex/routines/");
  assert.equal(routineRootOf("routines/daily/x.md"), "routines/");
  assert.equal(routineRootOf("tex/about-me.md"), null);
});

test("a note in the new root that will never run says why, naming its own root", () => {
  assert.match(routineFromPath("tex/routines/brief.md").reason, /tex\/routines\/daily\//);
  assert.match(routineFromPath("tex/routines/daily/old/brief.md").reason, /tex\/routines\/daily\//);
  assert.match(routineFromPath("tex/routines/someday/brief.md").reason, /isn't a schedule/);
  // The old root's sentences are unchanged.
  assert.match(routineFromPath("routines/brief.md").reason, /like routines\/daily\//);
});

test("only a root at the top of the workspace counts", () => {
  assert.equal(routineFromPath("tex/about-me.md"), null);
  assert.equal(routineFromPath("tex/daily/x.md"), null);
  assert.equal(routineFromPath("1-projects/tex/routines/daily/x.md"), null);
  assert.equal(routineFromPath("my-tex/routines/daily/x.md"), null);
  assert.equal(routineFromPath("tex-routines/daily/x.md"), null);
  // Case-insensitive like the old root.
  assert.equal(routineFromPath("Tex/Routines/daily/x.md").kind, "routine");
  assert.equal(isRoutinePath("tex/routines"), true);
  assert.equal(isRoutinePath("tex/routines/daily/x.md"), true);
  assert.equal(isRoutinePath("routines"), true);
  assert.equal(isRoutinePath("routines/daily/x.md"), true);
  // Moving or deleting the `tex` folder takes `tex/routines/` with it.
  assert.equal(isRoutinePath("tex"), true);
  assert.equal(isRoutinePath("/tex/"), true);
  assert.equal(isRoutinePath("tex/about-me.md"), false, "a note beside the root is not a routine change");
  assert.equal(isRoutinePath(""), false);
  assert.equal(isRoutinePath("te"), false);
  assert.equal(isRoutinePath("tex/routinesx/daily/x.md"), false);
  assert.equal(isRoutinePath("routinesx"), false);
  assert.equal(isRoutinePath(42), false);
});

test("run history for the two roots never collides, and the old key is unchanged", () => {
  assert.equal(routineRunsKey("routines/daily/x.md"), ".context/agent/routines/daily/x.json");
  assert.equal(routineRunsKey("tex/routines/daily/x.md"), ".context/agent/tex/routines/daily/x.json");
  assert.notEqual(routineRunsKey("routines/daily/x.md"), routineRunsKey("tex/routines/daily/x.md"));
  assert.equal(routineRunsKey("Tex/Routines/once/x.md"), ".context/agent/tex/routines/once/x.json");
});

test("a tex/routines/ note is scheduled exactly as its routines/ twin", () => {
  const text = "---\nat: 7:30 am\n---\nTell me what changed.";
  const after = Date.parse("2026-10-14T12:00:00Z");
  const runs = ["routines/daily/x.md", "tex/routines/daily/x.md"].map((path) => {
    const { cadence } = routineFromPath(path);
    const { settings, problems } = routineSettings(text, cadence);
    assert.deepEqual(problems, []);
    return nextRunAt(cadence, settings, NY, after);
  });
  assert.equal(runs[0], runs[1]);
  assert.equal(new Date(runs[1]).toISOString(), "2026-10-15T11:30:00.000Z");
});
