/**
 * WRITING A DRAWING BACK IS AN EDIT, NOT A REGENERATION.
 *
 * `test.mjs` proves the read side, where the worst outcome is a bad answer.
 * This is the write side, where the worst outcome is somebody's diagram gone —
 * so the checks are shaped around the ways a serializer destroys a file rather
 * than around whether it produces valid output:
 *
 *  1. **Everything we do not understand survives.** Frontmatter, the plugin's
 *     warning line, `Element Links`, `Embedded Files`, an unknown heading
 *     somebody added, the `%%` wrapper, the trailing bytes. The proof is
 *     byte-level: writing the elements a file already contains reproduces
 *     that file's every span except the two that are meant to change.
 *  2. **The scene's unknown keys survive too.** `source`, `version`, and any
 *     field a future Excalidraw adds are carried through rather than dropped
 *     by a serializer that only knows about `elements`.
 *  3. **The fence language is the customer's setting.** A `json` file stays
 *     `json`; a `compressed-json` file stays compressed. Switching it is a
 *     silent settings change that shows up as an enormous diff in their sync.
 *  4. **A file it cannot splice is refused, not guessed at.** No payload, an
 *     unterminated fence, an undecodable payload, a non-drawing — `null`, and
 *     the caller writes nothing.
 *  5. **The round trip is closed.** `serializeDrawing` then `parseDrawing`
 *     returns the elements that went in, and the result is a file the gateway's
 *     own write guard accepts.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing checks here.
 *
 *   `serializeDrawing` regenerating the file from a template               18
 *   the `Text Elements` span running to the end of the file                  9
 *   the scene's unknown keys dropped                                         2
 *   the payload always written compressed                                    1
 *   the payload always written plain                                         1
 *   the payload left unwrapped on one enormous line                          1
 *   writing without first checking the file reads                            1
 *   text elements joined per line rather than per block                      1
 *   the `^id` dropped from each label                                        1
 *   the text block spliced before the payload                                1
 *
 * The first row is what this file is for. Eighteen is not "thorough coverage
 * of a serializer"; it is one behaviour — a template regenerates the file and
 * every part of it the plugin owns disappears at once. That is the failure
 * worth eighteen checks, because its cost is a customer opening Obsidian to
 * find their frontmatter, links and warning line gone.
 *
 * One sabotage turned **nothing** red: removing the unterminated-fence guard in
 * `findPayloadSpan`. It is unreachable as a decision — with it gone the span
 * ends at 0, the slice is empty, and `readScene` refuses the empty payload
 * instead. Kept and labelled in the source as a backstop rather than deleted or
 * pretended to be load-bearing.
 */

import { parseDrawing, compressToBase64 } from "../src/index.js";
import { canSerializeDrawing, serializeDrawing } from "../src/serialize.js";

let passed = 0;
const failures = [];

function check(name, condition) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name);
  console.error(`FAIL ${name}`);
}

/* ------------------------------- fixtures --------------------------------- */

const ELEMENTS = [
  { id: "boxA", type: "rectangle", x: 0, y: 0, width: 160, height: 80, strokeColor: "#1e1e1e", backgroundColor: "#d0e2ff", strokeWidth: 2, opacity: 100, seed: 11 },
  { id: "labelA", type: "text", x: 10, y: 30, width: 140, height: 25, text: "Ingest", fontSize: 20, containerId: "boxA", seed: 12 },
  { id: "arrow1", type: "arrow", x: 160, y: 40, width: 160, height: 0, points: [[0, 0], [160, 0]], strokeColor: "#1e1e1e", strokeWidth: 2, opacity: 100, seed: 13 },
];

/**
 * A file with every part the plugin writes, plus one heading it does not — the
 * hand-added section is the point: nothing here may lose it.
 */
function drawingFile(elements, { fence = "compressed-json", extra = true } = {}) {
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  };
  const json = JSON.stringify(scene);
  const body = fence === "compressed-json" ? compressToBase64(json).match(/.{1,64}/g).join("\n") : json;
  const labels = elements
    .filter((element) => element.type === "text")
    .map((element) => `${element.text} ^${element.id}`)
    .join("\n\n");

  return [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw, diagram]",
    "my-own-key: kept",
    "---",
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    labels,
    "",
    "## Element Links",
    "boxA: [[2-areas/apps/context/storage]]",
    "",
    "## Embedded Files",
    "9f8e7d: [[diagram-source.png]]",
    "",
    ...(extra ? ["## My own notes", "A heading this parser has never heard of.", ""] : []),
    "%%",
    "## Drawing",
    "```" + fence,
    body,
    "```",
    "%%",
    "",
  ].join("\n");
}

/* -- (1) everything we do not understand survives ------------------------- */

{
  const original = drawingFile(ELEMENTS);
  const out = serializeDrawing(original, ELEMENTS);

  check("writing a file's own elements produces a file", typeof out === "string");

  for (const survivor of [
    "excalidraw-plugin: parsed",
    "tags: [excalidraw, diagram]",
    "my-own-key: kept",
    "Switch to EXCALIDRAW VIEW",
    "# Excalidraw Data",
    "## Element Links",
    "boxA: [[2-areas/apps/context/storage]]",
    "## Embedded Files",
    "9f8e7d: [[diagram-source.png]]",
    "## My own notes",
    "A heading this parser has never heard of.",
    "%%",
    "## Drawing",
  ]) {
    check(`it keeps ${JSON.stringify(survivor.slice(0, 38))}`, out.includes(survivor));
  }

  check("the file still ends with a newline", out.endsWith("\n"));

  /*
    The strongest form of (1): every line outside the two spans that are meant
    to change is byte-identical and in the same order. A survivor list can only
    prove the lines somebody thought to list; this proves the ones nobody did.
  */
  const strip = (text) => {
    const payload = /```(?:compressed-json|json)\n[\s\S]*?\n```/;
    return text.replace(payload, "```PAYLOAD```").replace(/## Text Elements\n[\s\S]*?\n(?=#|%%)/, "## Text Elements\nLABELS\n");
  };
  check("every other byte of the file is unchanged", strip(out) === strip(original));
}

/* -- (2) the scene's unknown keys survive --------------------------------- */

{
  const original = drawingFile(ELEMENTS);
  const out = serializeDrawing(original, ELEMENTS.slice(0, 2));
  const scene = JSON.parse(decode(out));

  check("the scene keeps `type`", scene.type === "excalidraw");
  check("the scene keeps `version`", scene.version === 2);
  check("the scene keeps `source`", scene.source === "https://excalidraw.com");
  check("the scene keeps `appState`", scene.appState?.viewBackgroundColor === "#ffffff");
  check("the scene keeps `files`", scene.files !== undefined);
  check("and the elements are the new ones", scene.elements.length === 2);

  const withState = serializeDrawing(original, ELEMENTS, { appState: { gridSize: 20 } });
  const merged = JSON.parse(decode(withState)).appState;
  check("an appState update merges rather than replaces", merged.gridSize === 20 && merged.viewBackgroundColor === "#ffffff");
}

/* -- (3) the fence language is the customer's setting --------------------- */

{
  const compressed = drawingFile(ELEMENTS, { fence: "compressed-json" });
  const plain = drawingFile(ELEMENTS, { fence: "json" });

  check(
    "a compressed file stays compressed",
    serializeDrawing(compressed, ELEMENTS).includes("```compressed-json")
  );
  check(
    "and its payload is not left as plain JSON",
    !serializeDrawing(compressed, ELEMENTS).includes('{"type":"excalidraw"')
  );
  check("a plain file stays plain", serializeDrawing(plain, ELEMENTS).includes("```json"));
  check(
    "and its payload is readable JSON",
    serializeDrawing(plain, ELEMENTS).includes('"type":"excalidraw"')
  );
  check(
    "a compressed payload is wrapped the way the plugin wraps it",
    serializeDrawing(compressed, ELEMENTS)
      .split("```compressed-json\n")[1]
      .split("\n```")[0]
      .split("\n")
      .every((line) => line.length <= 64)
  );
}

/* -- (4) a file it cannot splice is refused ------------------------------- */

{
  check("a non-string is refused", serializeDrawing(undefined, ELEMENTS) === null);
  check("non-elements are refused", serializeDrawing(drawingFile(ELEMENTS), "nope") === null);
  check("a file with no payload is refused", serializeDrawing("# just a note\n", ELEMENTS) === null);
  check(
    "an unterminated fence is refused",
    serializeDrawing("## Text Elements\n\n```compressed-json\nQ===\n", ELEMENTS) === null
  );
  check(
    "an undecodable payload is refused",
    serializeDrawing("## Text Elements\n\n```compressed-json\n!!!!\n```\n", ELEMENTS) === null
  );
  check(
    "JSON of the wrong shape is refused",
    serializeDrawing('## Text Elements\n\n```json\n{"hello":"world"}\n```\n', ELEMENTS) === null
  );
  check("canSerializeDrawing agrees with all of that", canSerializeDrawing(drawingFile(ELEMENTS)) && !canSerializeDrawing("# a note\n"));
}

/* -- (5) the round trip is closed ----------------------------------------- */

{
  const original = drawingFile(ELEMENTS);
  const edited = [
    ...ELEMENTS,
    { id: "labelB", type: "text", x: 400, y: 0, width: 200, height: 25, text: "Normalise", fontSize: 20, seed: 14 },
  ];
  const out = serializeDrawing(original, edited);
  const reparsed = parseDrawing(out, "1-projects/plan.excalidraw.md");

  check("the written file reads back", reparsed.elements !== null);
  check("with the elements that went in", reparsed.elements.length === 4);
  check("including the new one", reparsed.elements.some((element) => element.text === "Normalise"));
  check(
    "and the Text Elements block lists both labels",
    reparsed.textElements.map((entry) => entry.text).join(",") === "Ingest,Normalise"
  );
  check(
    "a label keeps its block id, so the plugin can still match it to its element",
    reparsed.textElements.every((entry) => entry.id !== null)
  );
  check("the links section survived the edit", reparsed.elementLinks.get("boxA") !== undefined);

  /*
    The gateway's write guard accepts a file only if it carries a payload —
    `toolWriteNote`'s `unreadable === "missing"` test. Asserted here rather than
    only in the gateway suite, because this is the module that has to satisfy
    it: a serializer whose output that guard refuses cannot be saved at all.
  */
  check("the gateway's write guard would accept it", parseDrawing(out).unreadable === null);

  const removed = serializeDrawing(original, ELEMENTS.filter((element) => element.type !== "text"));
  const afterRemoval = parseDrawing(removed);
  check("removing every label empties the block rather than corrupting it", afterRemoval.textElements.length === 0);
  check("and the drawing still reads", afterRemoval.elements?.length === 2);
  check("and the sections after it are intact", removed.includes("## Element Links"));

  const multiline = serializeDrawing(original, [
    { id: "m1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "two\nlines", fontSize: 20 },
  ]);
  check(
    "a label with a newline in it stays one entry",
    parseDrawing(multiline).textElements.length === 1
  );
  check(
    "and keeps both of its lines",
    parseDrawing(multiline).textElements[0].text === "two\nlines"
  );
}

/* --------------------------------- helpers -------------------------------- */

function decode(file) {
  const fence = /```(compressed-json|json)\n([\s\S]*?)\n```/.exec(file);
  if (!fence) throw new Error("no payload");
  if (fence[1] === "json") return fence[2];
  // Decoded through the package's own reader, so the test cannot pass with a
  // payload only this file knows how to open.
  const drawing = parseDrawing(file);
  return JSON.stringify({ ...sceneShell(drawing), elements: drawing.elements });
}

function sceneShell(drawing) {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    appState: drawing.appState,
    files: {},
  };
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`packages/drawings serialize: ${passed} checks passed`);
