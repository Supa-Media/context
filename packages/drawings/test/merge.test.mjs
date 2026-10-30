/**
 * TWO SAVES OF ONE DRAWING, COMBINED — `src/merge.js`.
 *
 * Two people drawing together both save, and the slower save is refused
 * because the faster one moved the version. The console answers that refusal
 * for a drawing by merging the two scenes instead of showing the conflict
 * page, so what is proven here is that the merge loses nobody's work:
 *
 *  1. Shapes only one side has are both kept.
 *  2. The same shape edited on both sides keeps the higher version, and an
 *     equal version is settled the same way whichever side merges.
 *  3. A deletion beats an older edit, and is not undone by the other side
 *     still holding the shape.
 *  4. The result is spliced into the bucket's version: its front matter and
 *     its own text survive, and it reads back as a drawing.
 *  5. Anything that is not a drawing this can splice is refused with null.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing checks here.
 *
 *   lower version wins                                                       5
 *   deleted elements dropped from both scenes before merging                 1
 *   nonce tiebreak reversed                                                  1
 *   files from the bucket side only                                          1
 *
 *   node packages/drawings/test/merge.test.mjs
 */

import { newDrawing, parseDrawing, serializeDrawing } from "../src/index.js";
import { mergeDrawings, mergeElements } from "../src/merge.js";
import { readDrawingScene } from "../src/serialize.js";

let passed = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name);
  console.error(`FAIL  ${name}`);
}

const el = (id, over = {}) => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 100,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  isDeleted: false,
  ...over,
});
const ids = (elements) => elements.map((e) => e.id).sort().join(",");
const file = (elements, options) => serializeDrawing(newDrawing(), elements, options);

// 1. Both sides' new shapes survive.
{
  const merged = mergeElements([el("a"), el("mine")], [el("a"), el("theirs")]);
  check("a shape only I drew is kept", merged.some((e) => e.id === "mine"));
  check("a shape only they drew is kept", merged.some((e) => e.id === "theirs"));
  check("one element per id", ids(merged) === "a,mine,theirs" && merged.length === 3);
}

// 2. The same shape moved on both sides.
{
  const mine = el("a", { version: 5, x: 50 });
  const theirs = el("a", { version: 3, x: 30 });
  check("my later version wins", mergeElements([mine], [theirs])[0].x === 50);
  check("their later version wins", mergeElements([el("a", { version: 2 })], [el("a", { version: 7, x: 70 })])[0].x === 70);
  const low = el("a", { version: 4, versionNonce: 1, x: 1 });
  const high = el("a", { version: 4, versionNonce: 9, x: 9 });
  check(
    "an equal version settles the same whichever side merges",
    mergeElements([low], [high])[0].x === 1 && mergeElements([high], [low])[0].x === 1,
  );
}

// 3. Deletions.
{
  const deleted = el("a", { version: 6, isDeleted: true });
  const moved = el("a", { version: 4, x: 40 });
  check("my deletion beats their older move", mergeElements([deleted], [moved])[0].isDeleted === true);
  check("their deletion beats my older move", mergeElements([moved], [deleted])[0].isDeleted === true);
  const text = mergeDrawings(file([deleted, el("b")]), file([moved, el("b")]));
  const scene = readDrawingScene(text);
  check(
    "a deletion saved to the file stays deleted after the merge",
    scene !== null && scene.elements.find((e) => e.id === "a")?.isDeleted === true,
  );
}

// 4. Spliced into the bucket's version.
{
  const theirs = file([el("t", { type: "text", text: "their label" })]).replace(
    "tags: [excalidraw]",
    "tags: [excalidraw]\nowner: them",
  );
  const mine = file([el("m", { type: "text", text: "my label" })], { files: { img1: { id: "img1", dataURL: "data:x" } } });
  const merged = mergeDrawings(mine, theirs);
  check("a merge is produced", typeof merged === "string");
  check("the bucket version's front matter survives", merged?.includes("owner: them") === true);
  const read = parseDrawing(merged ?? "", "a.excalidraw.md");
  check("the merge reads back with both shapes", read.elements !== null && ids(read.elements) === "m,t");
  check("both labels are in the Text Elements block", merged?.includes("my label ^m") && merged?.includes("their label ^t"));
  check("my embedded image survives", readDrawingScene(merged)?.files?.img1?.dataURL === "data:x");
}

// Order follows Excalidraw's fractional index when every element has one.
{
  const merged = mergeElements([el("b", { index: "a2" })], [el("a", { index: "a1" }), el("c", { index: "a3" })]);
  check("fractional index decides z-order", merged.map((e) => e.id).join(",") === "a,b,c");
}

// 5. Refusals.
{
  check("a non-drawing on my side is refused", mergeDrawings("# just a note\n", file([el("a")])) === null);
  check("a non-drawing in the bucket is refused", mergeDrawings(file([el("a")]), "# just a note\n") === null);
  check("nothing at all is refused", mergeDrawings(undefined, undefined) === null);
}

console.log(`merge: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
