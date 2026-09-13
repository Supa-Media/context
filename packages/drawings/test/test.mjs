/**
 * A DRAWING IS READ, NEVER REWRITTEN — `packages/drawings`.
 *
 * The rule this suite exists for is one sentence from
 * `docs/decisions/obsidian-plugins.md`: "`.canvas` and `.excalidraw.md` are
 * opaque, not malformed. A file we do not parse is still a file we do not
 * corrupt." Adding a parser is the moment that sentence is at risk, so the
 * checks are grouped by the four ways it could be broken:
 *
 *  1. **Every parse is read-only.** Nothing in this package returns a file body,
 *     and the input string is untouched by every path through it.
 *  2. **A file we cannot decode still opens.** Missing, truncated, oversized,
 *     non-base64 and non-Excalidraw payloads each produce a drawing with its
 *     labels and an honest sentence about the rest — never a throw.
 *  3. **The format is the plugin's, not ours.** Both fence languages, both
 *     heading levels, the `%%` wrapper, line-wrapped base64, multi-line labels,
 *     and a container's label living in a different element.
 *  4. **A floor is never printed as a total.** Past `MAX_ELEMENTS` the parse
 *     says it truncated and the description says so in words.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines in this
 * suite.
 *
 *   `labelOf` ignoring `byContainer`                                         4
 *   `MAX_ELEMENTS` truncation without the `truncated` flag                   4
 *   `findPayload` matching only ```json                                      2
 *   `parseTextElements` splitting per line rather than per block             2
 *   `sectionPattern` anchored to `##` only                                   2
 *   `normalizedBox` dropping the negative-width case                         1
 *   `decompressFromBase64` returning "" instead of null on garbage           1
 *   LZ-String compressing code points rather than code units                 1
 *   an arrow honouring `backgroundColor` the way a line does                 1
 *   a text baseline placed on its line box's top edge                        1
 *   rotation taken about the corner rather than the centre                   1
 *
 * Two findings came out of running these rather than out of writing them.
 *
 * The fifth row is why `# Text Elements` is tested at all: that is what a vault
 * written before the plugin moved to `##` still contains, and those are exactly
 * the oldest drawings somebody most wants to open. Nothing else here reaches
 * that path, so without those checks the old-vault case would have been
 * silently unsupported and would have looked like an empty drawing.
 *
 * The ninth started at **zero**. The fixture arrow had no `backgroundColor`, so
 * an arrow that wrongly honoured one was indistinguishable from one that did
 * not and the check passed either way — a guard nobody had checked, which
 * `docs/decisions/testing.md` says is not a guard. The fixture now carries one.
 *
 * One check is honestly weak and is kept anyway: "the payload is not in it", in
 * group (7). `drawingSearchText` is never handed the file body, so no sabotage
 * of *this* package can make it fail. It documents the intent; the guard that
 * can actually fail lives in the gateway suite, where the raw file is in scope.
  */

import {
  MAX_ELEMENTS,
  buildScene,
  compressToBase64,
  decompressFromBase64,
  describeDrawing,
  drawingName,
  drawingSearchText,
  isDrawingPath,
  parseDrawing,
} from "../src/index.js";

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

/** Two labelled boxes and an arrow between them: the shape of a real diagram. */
const SCENE = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [
    { id: "boxA", type: "rectangle", x: 0, y: 0, width: 160, height: 80, strokeColor: "#1e1e1e", backgroundColor: "#d0e2ff", fillStyle: "solid", strokeWidth: 2, opacity: 100 },
    { id: "labelA", type: "text", x: 10, y: 30, width: 140, height: 25, text: "Ingest", fontSize: 20, containerId: "boxA", textAlign: "center", verticalAlign: "middle" },
    { id: "boxB", type: "rectangle", x: 320, y: 0, width: 160, height: 80, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeWidth: 2, opacity: 100 },
    { id: "labelB", type: "text", x: 330, y: 30, width: 140, height: 25, text: "Normalise", fontSize: 20, containerId: "boxB", textAlign: "center", verticalAlign: "middle" },
    { id: "arrow1", type: "arrow", x: 160, y: 40, width: 160, height: 0, points: [[0, 0], [160, 0]], strokeColor: "#1e1e1e", backgroundColor: "#ffc9c9", strokeWidth: 2, opacity: 100, startBinding: { elementId: "boxA" }, endBinding: { elementId: "boxB" } },
    { id: "note1", type: "text", x: 0, y: 140, width: 300, height: 25, text: "Rejects go to 0-inbox", fontSize: 16, opacity: 100 },
    { id: "gone", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: true },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
};

function drawingFile(payload, { fence = "compressed-json", heading = "##", wrap = true } = {}) {
  const body = fence === "compressed-json" ? compressToBase64(payload) : payload;
  const fenced = ["```" + fence, body, "```"].join("\n");
  return [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "---",
    "",
    "# Excalidraw Data",
    "",
    `${heading} Text Elements`,
    "Ingest ^labelA",
    "",
    "Normalise ^labelB",
    "",
    `${heading} Element Links`,
    "boxB: [[2-areas/apps/context/storage]]",
    "",
    `${heading} Embedded Files`,
    "9f8e7d: [[diagram-source.png]]",
    "",
    wrap ? "%%" : "",
    `${heading} Drawing`,
    fenced,
    wrap ? "%%" : "",
    "",
  ].join("\n");
}

/* ---------------------------------- run ----------------------------------- */

/* -- (0) LZ-String, both directions ------------------------------------- */

{
  for (const value of ["", "a", "Hello, world!", JSON.stringify(SCENE), "emoji 🎨 ünïcode"]) {
    check(
      `lz-string round-trips ${JSON.stringify(value.slice(0, 20))}`,
      decompressFromBase64(compressToBase64(value)) === value
    );
  }

  /*
    Pinned output. These were produced by this implementation, so they do not
    prove agreement with pieroxy's — what they catch is a later change that
    alters the format, which is the failure that would reach a bucket.
  */
  check("compressToBase64 is stable for a known string", compressToBase64("Hello, world!") === "BIUwNmD2A0AEDukBOYAmBCIA");
  check("decompressFromBase64 reads that same string back", decompressFromBase64("BIUwNmD2A0AEDukBOYAmBCIA") === "Hello, world!");

  check("garbage decompresses to null, not to a throw", decompressFromBase64("!!!! not base64 !!!!") === null);
  check("an empty payload is null", decompressFromBase64("   \n  ") === null);
  check("a non-string is null", decompressFromBase64(undefined) === null);
  check(
    "line-wrapped base64 is the common case and decodes",
    decompressFromBase64(chunk(compressToBase64(JSON.stringify(SCENE)), 60)) === JSON.stringify(SCENE)
  );
}

/* -- (1) which keys are drawings ----------------------------------------- */

{
  check("a .excalidraw.md key is a drawing", isDrawingPath("1-projects/plan.excalidraw.md"));
  check("case does not decide it", isDrawingPath("1-projects/Plan.Excalidraw.MD"));
  check("a plain note is not", !isDrawingPath("1-projects/plan.md"));
  check("a bare .excalidraw is not a note at all", !isDrawingPath("1-projects/plan.excalidraw"));
  check("a non-string is not", !isDrawingPath(undefined));
  check("the name drops both extensions", drawingName("1-projects/plan.excalidraw.md") === "plan");
  check("a plain note keeps its stem", drawingName("1-projects/plan.md") === "plan");
}

/* -- (2) the format, as the plugin writes it ----------------------------- */

{
  const drawing = parseDrawing(drawingFile(JSON.stringify(SCENE)), "1-projects/plan.excalidraw.md");

  check("the compressed payload decodes", drawing.elements !== null);
  check("nothing is unreadable", drawing.unreadable === null);
  check("deleted elements are dropped", !drawing.elements.some((element) => element.id === "gone"));
  check("live elements are kept", drawing.elements.length === 6);
  check("the name comes from the key", drawing.name === "plan");

  check("text elements are read from the Markdown half", drawing.textElements.length === 2);
  check("a text element's block id is not part of its text", drawing.textElements[0].text === "Ingest");
  check("the block id is kept separately", drawing.textElements[0].id === "labelA");
  check("element links parse", drawing.elementLinks.get("boxB") === "[[2-areas/apps/context/storage]]");
  check("embedded files parse", drawing.embeddedFiles.get("9f8e7d") === "[[diagram-source.png]]");

  const uncompressed = parseDrawing(drawingFile(JSON.stringify(SCENE), { fence: "json" }), "plan.excalidraw.md");
  check("an uncompressed ```json payload reads the same", uncompressed.elements?.length === 6);

  const oldVault = parseDrawing(drawingFile(JSON.stringify(SCENE), { heading: "#" }), "plan.excalidraw.md");
  check("a pre-`##` vault still finds its text elements", oldVault.textElements.length === 2);
  check("a pre-`##` vault still finds its links", oldVault.elementLinks.get("boxB") !== undefined);
  check("a pre-`##` vault still decodes its payload", oldVault.elements?.length === 6);

  const noComment = parseDrawing(drawingFile(JSON.stringify(SCENE), { wrap: false }), "plan.excalidraw.md");
  check("a file missing its %% wrapper still parses", noComment.elements?.length === 6);

  const multiline = parseDrawing(
    ["## Text Elements", "first line", "second line ^abc123", "", "another ^def456"].join("\n"),
    "x.excalidraw.md"
  );
  check("a label written across lines is one label", multiline.textElements.length === 2);
  check("its lines are kept together", multiline.textElements[0].text === "first line\nsecond line");

  const foreign = parseDrawing(
    ["## Text Elements", "kept ^a1", "", "## Notes", "this is prose, not a label"].join("\n"),
    "x.excalidraw.md"
  );
  check("an unknown heading ends the section it follows", foreign.textElements.length === 1);
}

/* -- (3) a file we cannot decode still opens ----------------------------- */

{
  const noPayload = parseDrawing(["## Text Elements", "Ingest ^labelA"].join("\n"), "plan.excalidraw.md");
  check("a file with no payload is not an error", noPayload.unreadable === "missing");
  check("its labels survive", noPayload.textElements[0].text === "Ingest");
  check("its elements are null rather than empty", noPayload.elements === null);
  check(
    "the description says what is missing",
    describeDrawing(noPayload).includes("no drawing payload")
  );
  check("the description still lists the labels", describeDrawing(noPayload).includes("Ingest"));

  const garbled = parseDrawing(["```compressed-json", "!!!!!!", "```"].join("\n"), "plan.excalidraw.md");
  check("an undecodable payload is reported as such", garbled.unreadable === "undecodable");
  check("and says the file is untouched", describeDrawing(garbled).includes("untouched"));

  const notJson = parseDrawing(["```json", "{ not json", "```"].join("\n"), "plan.excalidraw.md");
  check("a payload that is not JSON is undecodable, not a throw", notJson.unreadable === "undecodable");

  const wrongShape = parseDrawing(['```json', '{"hello":"world"}', "```"].join("\n"), "plan.excalidraw.md");
  check("JSON without an elements array is unrecognised", wrongShape.unreadable === "unrecognised");

  const oversized = parseDrawing(["```compressed-json", "A".repeat(4_000_001), "```"].join("\n"), "plan.excalidraw.md");
  check("an oversized payload is refused before decoding", oversized.unreadable === "oversized");
  check("and the refusal says how big it was", describeDrawing(oversized).includes("past what is decoded inline"));

  check("an empty file parses to a drawing", parseDrawing("", "x.excalidraw.md").unreadable === "missing");
  check("a non-string parses to a drawing", parseDrawing(undefined, "x.excalidraw.md").unreadable === "missing");
}

/* -- (4) nothing here rewrites the file ---------------------------------- */

{
  const source = drawingFile(JSON.stringify(SCENE));
  const before = String(source);
  const drawing = parseDrawing(source, "plan.excalidraw.md");
  describeDrawing(drawing, { path: "plan.excalidraw.md" });
  drawingSearchText(drawing);
  buildScene(drawing.elements);
  check("the input is byte-identical after a full parse, describe and render", source === before);
  check(
    "no exported function returns anything resembling the file body",
    !describeDrawing(drawing).includes("compressed-json") &&
      !drawingSearchText(drawing).includes("compressed-json")
  );
}

/* -- (5) the description is the picture, in words ------------------------ */

{
  const drawing = parseDrawing(drawingFile(JSON.stringify(SCENE)), "1-projects/plan.excalidraw.md");
  const description = describeDrawing(drawing, { path: "1-projects/plan.excalidraw.md" });

  check("it is titled with the drawing's name", description.startsWith("# plan"));
  check("it counts what is in the drawing", description.includes("2 rectangles"));
  check("it gives the canvas size", /spanning \d+×\d+/.test(description));

  check("a container's label is attributed to its shape", description.includes("Ingest (rectangle)"));
  check("a free-standing label is listed as itself", description.includes("- Rejects go to 0-inbox"));
  const labelSection = description.slice(
    description.indexOf("## Labels"),
    description.indexOf("## Connections")
  );
  check(
    "a container's label is listed once, not as both the text and the shape",
    labelSection.split("Ingest").length - 1 === 1
  );

  check("a bound arrow becomes a connection", description.includes("Ingest → Normalise"));
  check("an element link is reported", description.includes("[[2-areas/apps/context/storage]]"));
  check("an embedded file is reported", description.includes("diagram-source.png"));

  const labels = description.slice(description.indexOf("## Labels"));
  check(
    "labels are in reading order, not array order",
    labels.indexOf("Ingest") < labels.indexOf("Normalise") &&
      labels.indexOf("Normalise") < labels.indexOf("Rejects")
  );

  /*
    The band regression. These three sit on one visual row, but their tops
    straddle a multiple of BAND — which is exactly what a fixed grid gets wrong,
    and what reading a real diagram's description surfaced.
  */
  const row = parseDrawing(
    [
      "```json",
      JSON.stringify({
        type: "excalidraw",
        elements: [
          { id: "c", type: "text", x: 600, y: -10, width: 80, height: 20, text: "third" },
          { id: "a", type: "text", x: 0, y: 0, width: 80, height: 20, text: "first" },
          { id: "b", type: "text", x: 300, y: 8, width: 80, height: 20, text: "second" },
        ],
      }),
      "```",
    ].join("\n"),
    "row.excalidraw.md"
  );
  const order = describeDrawing(row);
  check(
    "one visual row reads left to right even across a band boundary",
    order.indexOf("first") < order.indexOf("second") && order.indexOf("second") < order.indexOf("third")
  );

  const unbound = parseDrawing(
    [
      "```json",
      JSON.stringify({
        type: "excalidraw",
        elements: [{ id: "a", type: "arrow", x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]] }],
      }),
      "```",
    ].join("\n"),
    "x.excalidraw.md"
  );
  check(
    "an arrow bound to nothing is not described as a connection",
    !describeDrawing(unbound).includes("## Connections")
  );
}

/* -- (6) a floor is never a total ---------------------------------------- */

{
  const many = {
    type: "excalidraw",
    elements: Array.from({ length: MAX_ELEMENTS + 10 }, (_, index) => ({
      id: `e${index}`,
      type: "rectangle",
      x: index,
      y: 0,
      width: 5,
      height: 5,
    })),
  };
  const drawing = parseDrawing(["```json", JSON.stringify(many), "```"].join("\n"), "big.excalidraw.md");
  check("a huge drawing is cut to the cap", drawing.elements.length === MAX_ELEMENTS);
  check("and says it was cut", drawing.truncated === true);
  check("the description prints the floor as a floor", describeDrawing(drawing).includes(`${MAX_ELEMENTS}+ elements`));
  check("and says what it left out", describeDrawing(drawing).includes("the drawing has more"));
}

/* -- (7) what the indexer stores ----------------------------------------- */

{
  const drawing = parseDrawing(drawingFile(JSON.stringify(SCENE)), "1-projects/plan.excalidraw.md");
  const text = drawingSearchText(drawing);

  check("the drawing's name is searchable", text.includes("plan"));
  check("its labels are searchable", text.includes("Ingest") && text.includes("Normalise"));
  check("the note it links to is searchable", text.includes("2-areas/apps/context/storage"));
  check(
    "the payload is not in it",
    !text.includes(compressToBase64(JSON.stringify(SCENE)).slice(0, 40))
  );
  check(
    "and it is a fraction of the file",
    text.length < drawingFile(JSON.stringify(SCENE)).length / 4
  );

  check(
    "a label the plugin writes twice is one term, not two",
    text.split("Ingest").length - 1 === 1
  );

  const unreadable = parseDrawing(["## Text Elements", "Ingest ^a1"].join("\n"), "plan.excalidraw.md");
  check("an undecodable drawing is still searchable by its labels", drawingSearchText(unreadable).includes("Ingest"));
}

/* -- (8) the scene a renderer is handed ---------------------------------- */

{
  const drawing = parseDrawing(drawingFile(JSON.stringify(SCENE)), "plan.excalidraw.md");
  const scene = buildScene(drawing.elements);

  check("every drawable element becomes at least one node", scene.nodes.length >= 6);
  check(
    "the viewBox covers the scene with padding",
    scene.viewBox.x === -16 && scene.viewBox.width === 480 + 32
  );

  const rect = scene.nodes.find((node) => node.id === "boxA");
  check("a rectangle keeps its geometry", rect.kind === "rect" && rect.width === 160 && rect.height === 80);
  check("a solid fill is opaque", rect.fill === "#d0e2ff" && rect.fillOpacity === 1);

  const hollow = scene.nodes.find((node) => node.id === "boxB");
  check("a transparent background is not filled", hollow.fill === "none" && hollow.fillOpacity === 0);

  const arrow = scene.nodes.find((node) => node.id === "arrow1");
  check("an arrow is a path", arrow.kind === "path" && arrow.d.startsWith("M160 40"));
  // The fixture arrow carries a backgroundColor on purpose: an arrow that
  // honoured it would be drawn as a filled wedge rather than as a stroke.
  check("an arrow is never filled, even when it carries a background", arrow.fill === "none");
  const closed = buildScene([
    { id: "l", type: "line", x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 0], [10, 10], [0, 0]], backgroundColor: "#ffc9c9", fillStyle: "solid" },
  ]);
  check("a line does honour its background, because it encloses a shape", closed.nodes[0].fill === "#ffc9c9");
  const head = scene.nodes.find((node) => node.id === "arrow1:end");
  check("an arrow gets a head at its tip by default", head && head.points[0][0] === 320);
  check("the head is filled in the stroke colour", head.fill === "#1e1e1e");

  const label = scene.nodes.find((node) => node.id === "labelA");
  check("a label is centred when its element says so", label.anchor === "middle" && label.lines[0].x === 80);
  check("a baseline is inside the line box, not on its top edge", label.lines[0].y > 30);

  const wrapped = buildScene([
    { id: "t", type: "text", x: 0, y: 0, width: 100, height: 60, text: "one\ntwo", fontSize: 20 },
  ]);
  const multi = wrapped.nodes[0];
  check("each line of a text element gets its own baseline", multi.lines.length === 2);
  check("and they step by the line height", Math.round(multi.lines[1].y - multi.lines[0].y) === 25);

  const negative = buildScene([
    { id: "n", type: "rectangle", x: 100, y: 100, width: -40, height: -20 },
  ]);
  const flipped = negative.nodes[0];
  check(
    "a box dragged up and left is normalised rather than drawn inside out",
    flipped.x === 60 && flipped.y === 80 && flipped.width === 40 && flipped.height === 20
  );

  const rotated = buildScene([
    { id: "r", type: "rectangle", x: 0, y: 0, width: 100, height: 100, angle: Math.PI / 2 },
  ]);
  check(
    "rotation is about the centre, in degrees",
    Math.round(rotated.nodes[0].rotate.degrees) === 90 && rotated.nodes[0].rotate.cx === 50
  );

  const empty = buildScene([]);
  check("an empty scene still has a usable viewBox", empty.viewBox.width > 0 && empty.nodes.length === 0);
  check("a null element list does not throw", buildScene(null).nodes.length === 0);

  const capped = buildScene(
    Array.from({ length: 20 }, (_, index) => ({ id: `e${index}`, type: "rectangle", x: index, y: 0, width: 1, height: 1 })),
    { maxNodes: 5 }
  );
  check("the renderer's own cap is reported", capped.truncated === true && capped.nodes.length === 5);
}

/* -- a fence inside a text label is not the payload ------------------------ */

{
  /*
   * THE MARKDOWN HALF IS NOT ALL WRITTEN BY THE PLUGIN.
   *
   * `findPayload` took the first ```compressed-json or ```json fence anywhere
   * in the file, and said why: "these two fence languages do not appear in the
   * Markdown half — the plugin writes that half itself." The `Text Elements`
   * block is the counter-example, and it is not an edge case — it is the one
   * section whose content is a person's own typing, copied in verbatim by the
   * plugin and by `renderTextElements` alike, newlines and all.
   *
   * So a drawing whose text label contains a fence puts a second payload above
   * the real one, and the reader took it. Nobody has to be attacked for this to
   * matter — a label that quotes a snippet of a drawing file does it by
   * accident — but the file can also arrive by email into `0-inbox/`, which is
   * the ingestion design rather than a gap in it.
   *
   * Two consequences, and the write side is the worse one: `serializeDrawing`
   * splices into the same fence it reads, so an edit lands in the decoy and the
   * customer's real drawing keeps its old contents while both sit in the file.
   */
  const decoy = compressToBase64(
    JSON.stringify({ type: "excalidraw", version: 2, files: {}, appState: {},
      elements: [{ id: "decoy", type: "text", x: 0, y: 0, text: "not yours" }] })
  );
  const real = compressToBase64(
    JSON.stringify({ type: "excalidraw", version: 2, files: {}, appState: {},
      elements: [{ id: "real", type: "rectangle", x: 0, y: 0, width: 4, height: 4 }] })
  );
  const file = [
    "---", "excalidraw-plugin: parsed", "---",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    "see the format:",
    "```compressed-json",
    decoy,
    "```",
    "^t1",
    "",
    "%%",
    "## Drawing",
    "```compressed-json",
    real,
    "```",
    "%%",
    "",
  ].join("\n");

  const parsed = parseDrawing(file, "1-projects/plan.excalidraw.md");
  check(
    "a fence inside a text label is not read as the payload",
    parsed.elements?.length === 1 && parsed.elements[0].id === "real"
  );
  check(
    "and the decoy's elements are nowhere in the result",
    !JSON.stringify(parsed.elements ?? []).includes("decoy")
  );
}

/* --------------------------------- report --------------------------------- */

function chunk(value, size) {
  const out = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out.join("\n");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`packages/drawings: ${passed} checks passed`);
