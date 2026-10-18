/**
 * A parse reads a bounded part of the file: `MAX_DRAWING_CHARS`.
 *
 * Kept out of `test.mjs`, which is past the architecture size threshold.
 *
 * Sabotage record (temporary local edit, reverted): `parseDrawing` reading the
 * whole file instead of its first `MAX_DRAWING_CHARS` characters fails 3
 * checks here. The timing checks do not fail under it, because the parse is
 * linear; they guard against a regression to something slower.
 */

import { MAX_ELEMENTS, compressToBase64, parseDrawing } from "../src/index.js";
import { MAX_DRAWING_CHARS } from "../src/excalidraw.js";

let passed = 0;
const failures = [];

function check(name, condition) {
  if (condition) passed += 1;
  else {
    failures.push(name);
    console.error(`FAIL ${name}`);
  }
}

{
  // Labels alone, several megabytes of them: the Markdown half has no payload
  // limit of its own, so only the file cap bounds it.
  const labels = Array.from({ length: 400_000 }, (_, index) => `label ${index} ^id${index}`).join("\n\n");
  const huge = `## Text Elements\n${labels}\n%%\n`;
  let started = performance.now();
  const drawing = parseDrawing(huge, "huge.excalidraw.md");
  let ms = performance.now() - started;
  const kept = drawing.textElements.reduce((sum, element) => sum + element.text.length, 0);
  check(`a ${(huge.length / 1e6).toFixed(1)} MB drawing parses in under 2 s (took ${Math.round(ms)} ms)`, ms < 2000);
  check("and reads no more than the file cap", kept < MAX_DRAWING_CHARS && kept > 0);
  check("and says it was cut", drawing.truncated === true);
  check("the labels past the cap are not read", !drawing.textElements.some((element) => element.text === "label 399999"));

  const many = {
    type: "excalidraw",
    elements: Array.from({ length: 40_000 }, (_, index) => ({ id: `e${index}`, type: "text", x: index, y: 0, width: 5, height: 5, text: `t${index}` })),
  };
  const compressed = ["```compressed-json", compressToBase64(JSON.stringify(many)), "```"].join("\n");
  started = performance.now();
  const crowded = parseDrawing(compressed, "crowded.excalidraw.md");
  ms = performance.now() - started;
  check(`a 40,000-element drawing parses in under 2 s (took ${Math.round(ms)} ms)`, ms < 2000);
  check("and is cut at the element cap", crowded.elements.length === MAX_ELEMENTS && crowded.truncated === true);

  // Exactly at the cap nothing is cut: the last label is still read.
  const head = "## Text Elements\n";
  const exact = head + "x".repeat(MAX_DRAWING_CHARS - head.length - 4) + "\n\nzz";
  const atCap = parseDrawing(exact, "exact.excalidraw.md");
  check("a drawing at the cap is read whole", exact.length === MAX_DRAWING_CHARS && atCap.truncated === false && atCap.textElements.at(-1).text === "zz");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`packages/drawings bounds: ${passed} checks passed`);
