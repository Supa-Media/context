/**
 * WHAT GOES ON THE WIRE WHEN TWO PEOPLE DRAW — `src/collab.js`.
 *
 * This module does not merge anything, and the first thing worth asserting is
 * that it still does not: the merge is Excalidraw's `reconcileElements`, and a
 * second implementation living here would be the one that drifts. What is here
 * is the two questions either side of it — which elements are worth sending,
 * and how a set of them is encoded for a channel that carries opaque base64 —
 * plus the shape check on what a peer sent.
 *
 *   node packages/drawings/test/collab.test.mjs
 */

import {
  changedElements,
  decodeElements,
  encodeElements,
  looksLikeElement,
  remember,
} from "../src/collab.js";

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

const element = (over = {}) => ({
  id: "a",
  type: "rectangle",
  version: 1,
  versionNonce: 111,
  x: 0,
  y: 0,
  ...over,
});

/* ------------------------- what is worth sending -------------------------- */

{
  const seen = new Map();
  const first = changedElements([element()], seen);
  check("an element nobody has sent is sent", first.length === 1);

  remember(first, seen);
  check(
    "...and is not sent again while it has not changed",
    // Excalidraw reports a change per animation frame while somebody drags. A
    // version of this that sent everything each time would fill the room's log
    // with a thousand copies of one rectangle.
    changedElements([element()], seen).length === 0,
  );

  check(
    "a moved element is sent again",
    changedElements([element({ version: 2, versionNonce: 222 })], seen).length === 1,
  );
  check(
    "a nonce change alone counts, because that is how a tie is broken",
    changedElements([element({ version: 1, versionNonce: 999 })], seen).length === 1,
  );
  check(
    "a version that went backwards is sent, because an undo does that",
    // The peer holding the higher version wins the reconciliation, which is the
    // correct outcome and not this function's decision to make.
    changedElements([element({ version: 0, versionNonce: 5 })], seen).length === 1,
  );
}

{
  const seen = new Map();
  const mine = changedElements([element()], seen);
  check(
    "asking what changed does not record that it was sent",
    // A caller whose send throws must not have recorded that it succeeded, or
    // that element is never broadcast again and one person's rectangle is
    // invisible to everybody else for the rest of the session.
    mine.length === 1 && seen.size === 0 && changedElements([element()], seen).length === 1,
  );
}

{
  const seen = new Map();
  check(
    "an element with no id is dropped rather than sent",
    changedElements([{ type: "rectangle", version: 1 }, null, "nope"], seen).length === 0,
  );
}

/* ------------------------------ the shape check --------------------------- */

check("an element needs an id and a type", looksLikeElement(element()));
check("...and is refused without them", !looksLikeElement({ id: "a" }) && !looksLikeElement({ type: "rectangle" }));
check("a version that is not a number is refused", !looksLikeElement(element({ version: "2" })));
check(
  "a field this package has never heard of is passed, not refused",
  // Excalidraw's element shape changes between versions. A validator that knew
  // it would start rejecting valid drawings on the next bump, which is a worse
  // failure than anything it would catch.
  looksLikeElement({ ...element(), somethingNew: { nested: true } }),
);
check("an array is not an element", !looksLikeElement([element()]));

/* --------------------------------- the wire -------------------------------- */

{
  const scene = [element(), element({ id: "b", type: "text", text: "héllo 🌍 — em dash" })];
  const round = decodeElements(encodeElements(scene));
  check(
    "a scene survives the round trip, non-ASCII labels included",
    // `btoa(JSON.stringify(...))` throws on any of these, and a drawing whose
    // text is not ASCII is an ordinary drawing.
    JSON.stringify(round) === JSON.stringify(scene),
  );
}

check("a payload that is not base64 decodes to nothing rather than throwing", decodeElements("!!!").length === 0);
check("a payload that is not JSON decodes to nothing", decodeElements(encodeElementsRaw("not json")).length === 0);
check(
  "a payload that is JSON but not a list decodes to nothing",
  decodeElements(encodeElementsRaw(JSON.stringify({ id: "a" }))).length === 0,
);
{
  const mixed = encodeElementsRaw(JSON.stringify([element(), { nope: true }, element({ id: "c" })]));
  check(
    "one bad element costs that element, not the whole message",
    decodeElements(mixed).map((one) => one.id).join(",") === "a,c",
  );
}

{
  // 40,000 elements is past `String.fromCharCode(...bytes)`'s argument limit,
  // which is a crash on exactly the drawings that need this most.
  const big = Array.from({ length: 4000 }, (_, i) => element({ id: `e${i}` }));
  const round = decodeElements(encodeElements(big));
  check("a large scene encodes without overflowing the argument limit", round.length === 4000);
}

function encodeElementsRaw(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`packages/drawings collab: ${passed} checks passed`);
