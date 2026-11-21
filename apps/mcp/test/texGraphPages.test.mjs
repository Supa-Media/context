/**
 * THE LAB'S PAGES (Dev2, 2026-11-20: "the nightly cleanup is a different type of AI job. It's not really texting, so it
 * should probably live in a different graph"). Tex keeps one config, `texConfig.json`; a step's `graph` names the Lab page
 * it lives on, "texting" (the default, when absent) or "nightly". These hold the schema's side (a known page only, and no
 * wire between pages), the committed config's nightly steps, and tex_dev's parity with the Lab's switcher: `set` moves a
 * step, `link` writes `?graph=nightly`, `snapshot` draws one page, and the guide lists main's steps by page.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-20).
 *
 *  1. The cross-page wire check in `configProblems` removed. → "a wire between two pages is refused" fails.
 *  2. `graph` accepting any words in `NODE_SHAPE`. → "a step's graph is one of the Lab's pages" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import schema from "../../../packages/tex/src/texConfigSchema.cjs";
import ops from "../../../packages/lab/src/texLabOps.cjs";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import * as R from "../../../packages/lab/gateway/texDev/replay.generated.js";
import { linkAnswer } from "../../../packages/lab/gateway/texDev/replay.js";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { drawingFor } from "../../../scripts/tex-architecture.mjs";

const { GRAPHS, graphOf, configProblems, NODE_FIELDS } = schema;
const ORIGIN = "https://context.example";
const NIGHTLY = ["nightly", "dream", "daysum", "housekeep", "aboutExpire", "aboutCheck"];
const copy = () => structuredClone(TEX_CONFIG);

test("the pages are texting, nightly and search, and a step with no graph is on texting", () => {
  assert.deepEqual([...GRAPHS], ["texting", "nightly", "search"]);
  assert.equal(graphOf({ id: "x", graph: "search" }), "search");
  assert.ok(NODE_FIELDS.includes("graph"));
  assert.equal(graphOf({ id: "x" }), "texting");
  assert.equal(graphOf({ id: "x", graph: "nightly" }), "nightly");
});

test("the committed config puts the nightly cleanup on its own page, and passes its schema", () => {
  assert.deepEqual(configProblems(TEX_CONFIG), []);
  assert.deepEqual(TEX_CONFIG.nodes.filter((n) => graphOf(n) === "nightly").map((n) => n.id).sort(), [...NIGHTLY].sort());
  for (const n of TEX_CONFIG.nodes.filter((n) => !NIGHTLY.includes(n.id))) assert.equal(n.graph, undefined, `${n.id} stays on texting by default`);
});

test("a step's graph is one of the Lab's pages", () => {
  const c = copy();
  c.nodes.find((n) => n.id === "dream").graph = "weekly";
  assert.ok(configProblems(c).some((p) => /step "dream" graph must be one of texting, nightly/.test(p)), configProblems(c).join("; "));
});

test("a wire between two pages is refused", () => {
  const c = copy();
  c.edges.push({ from: "send", to: "dream", mode: "background", when: ["sent"] });
  assert.ok(configProblems(c).some((p) => /the wire send → dream joins a step on the texting graph to one on the nightly graph/.test(p)), configProblems(c).join("; "));
  // Moving one step of a wired pair is refused the same way, so a page moves with the steps wired to it.
  const moved = copy();
  moved.nodes.find((n) => n.id === "daysum").graph = "texting";
  assert.ok(configProblems(moved).some((p) => /dream → daysum/.test(p)));
});

test("tex_dev edit moves a step with set graph, and null puts it back on texting", () => {
  const g = { nodes: copy().nodes, edges: copy().edges };
  const there = ops.applyOps(g, [{ op: "set", node: "learn", field: "graph", value: "nightly" }]);
  assert.equal(there.graph.nodes.find((n) => n.id === "learn").graph, "nightly");
  const back = ops.applyOps(there.graph, [{ op: "set", node: "learn", field: "graph", value: null }]);
  assert.equal(back.graph.nodes.find((n) => n.id === "learn").graph, undefined);
});

test("link writes the canvas's page into the Lab's address, as its switcher does", async () => {
  assert.equal((await linkAnswer({}, { graph: "nightly" }, { origin: ORIGIN })).link, `${ORIGIN}/lab?graph=nightly`);
  assert.equal((await linkAnswer({}, { graph: "nightly" }, { origin: ORIGIN, draft: "vabc" })).link, `${ORIGIN}/lab?v=vabc&graph=nightly`);
  assert.equal((await linkAnswer({}, { graph: "texting" }, { origin: ORIGIN })).link, `${ORIGIN}/lab`);
  assert.deepEqual(R.placeOf("?graph=nightly"), { mode: "lab", view: "canvas", chat: "me", moment: null, graph: "nightly" });
  assert.match((await linkAnswer({}, { graph: "weekly" }, { origin: ORIGIN })).error, /graph is one of texting, nightly/);
  assert.match((await linkAnswer({}, { graph: "nightly", page: "sim" }, { origin: ORIGIN })).error, /opens on the canvas/);
});

test("snapshot with graph: nightly draws only the Nightly page, through the picture renderer", async () => {
  let sent = null;
  const shots = {
    async fetch(_url, init) {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ png: "cG5n", width: 10, height: 10 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const call = createTexDev({ env: { APP_ORIGIN: ORIGIN, SITE_SHOTS: shots }, session: { accessToken: "tok" }, controlPlane: { async texDev() { return null; } } });
  const shot = await call("snapshot", { graph: "nightly" });
  assert.equal(shot.content[0].type, "image");
  assert.match(shot.content[1].text, /Main as it runs today \(its nightly page\)/);
  const ids = [...sent.html.matchAll(/<g class="nd [^"]*" data-id="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), [...NIGHTLY].sort());
  const bad = await call("snapshot", { graph: "weekly" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /one of texting, nightly/);
});

test("the guide lists main's steps by page, and the drawing draws each page on its own", () => {
  const text = guideText();
  const texting = text.indexOf("### Texting graph");
  const nightly = text.indexOf("### Nightly graph");
  assert.ok(texting > 0 && nightly > texting);
  for (const id of NIGHTLY) assert.ok(text.indexOf(`  - ${id} (`) > nightly, `${id} is listed under the Nightly graph`);
  assert.match(text, /field "graph" moves it to a Lab page/);
  const drawing = drawingFor(TEX_CONFIG);
  const [textingPart, nightlyPart] = drawing.split("### Nightly");
  assert.ok(textingPart.startsWith("### Texting") && nightlyPart);
  for (const id of NIGHTLY) {
    assert.ok(nightlyPart.includes(`n_${id}`), `${id} is drawn on Nightly`);
    assert.ok(!textingPart.includes(`n_${id}[`) && !textingPart.includes(`n_${id}(`), `${id} is not drawn on Texting`);
  }
});
