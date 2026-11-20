/**
 * `tex_dev snapshot`: a Tex Lab graph drawn as the Lab draws it (`packages/lab/gateway/texDev/snapshot.js`). The drawing is the Lab's own
 * `render.ts`, bundled to `canvas.generated.js` (`scripts/tex-dev-canvas.mjs`); these tests hold what the gateway adds:
 * the whole graph with its groups folded, a focus that opens a group, the marks against a base, and the hand-off to
 * the picture renderer.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-15).
 *
 *  1. `markOverlay` drawing nothing. → "a changed step is ringed and a new one tagged" fails.
 *  2. `sameStep` comparing x and y too. → "moving a step is not a change" fails.
 *  3. `snapshotGraph` ignoring `shots.fetch`'s status. → "a failing render gives one plain sentence" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { graphSvg, snapshotGraph } from "../../../packages/lab/gateway/texDev/snapshot.js";
import { readTexConfig } from "../../../scripts/lib/texConfigFile.mjs";

const config = readTexConfig();

const main = () => ({ nodes: structuredClone(config.nodes), edges: structuredClone(config.edges) });
/** The Lab draws a label at most 15 characters, cut with an ellipsis, and escapes it. */
const drawn = (label) => (label.length > 15 ? label.slice(0, 14) + "…" : label).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** A group's card is wider than a step: its name keeps 16 characters (`groupCard.ts`). */
const carded = (label) => (label.length > 16 ? label.slice(0, 15) + "…" : label).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const stepsDrawn = (html) => [...html.matchAll(/<g class="nd [^"]*" data-id="([^"]*)"/g)].map((m) => m[1]);

test("the whole graph draws every top-level step, each group folded into its box", () => {
  const g = main();
  const html = graphSvg(g);
  const top = g.nodes.filter((n) => !n.group);
  assert.ok(top.length > 10);
  for (const n of top) assert.ok(html.includes(`>${drawn(n.label)}</text>`), `missing ${n.id}`);
  const used = new Set(g.nodes.map((n) => n.group).filter(Boolean));
  // The "retired" group went with its steps (2026-11-20); intake still folds into its box.
  assert.ok(used.has("intake") && !used.has("retired"));
  for (const [id, group] of Object.entries(config.groups).filter(([id]) => used.has(id))) {
    assert.ok(html.includes(`>${carded(group.label)}</text>`), `missing the card of ${id}`);
    assert.ok(stepsDrawn(html).includes(id));
  }
  for (const n of g.nodes.filter((n) => n.group)) assert.ok(!stepsDrawn(html).includes(n.id), `${n.id} should be folded away`);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('data-theme="dark"'));
  assert.ok(html.includes(".nd .card{"), "the Lab's own stylesheet rides inline");
  assert.ok(!html.includes("<script"));
});

test("focus on a group draws just that group: its steps in a frame, the wires leaving it as pills (Dev2, 2026-11-16)", () => {
  const g = main();
  const members = g.nodes.filter((n) => n.group === "intake");
  assert.equal(members.length, 7);
  const html = graphSvg(g, { focus: "intake" });
  const shown = stepsDrawn(html);
  assert.deepEqual([...shown].sort(), members.map((m) => m.id).sort(), "only the group's own steps are drawn");
  assert.ok(html.includes('class="gframe"'));
  // The Door's two wires out: to the Front door on "next", to Confirmations & refusals on "answered".
  assert.ok(html.includes('data-gport="fd"') && html.includes('data-gport="bypass"'));
  assert.ok(!html.includes('data-gport="send"'), "a wire that never touches the group has no pill");
});

test("focus on a step inside a group draws the step's own view, as the Lab's double-click does", () => {
  const html = graphSvg(main(), { focus: "decide" });
  assert.ok(html.includes("Comes in") && html.includes("Gives out"));
  assert.ok(!html.includes('class="gframe"'));
  assert.ok(html.includes(">Intake / Decide</b>"), "the caption is the path to the step");
});

test("groups nest: the whole graph folds a nested group into its top group, which opens to show it as a card", () => {
  const g = main();
  g.groups = { checks2: { label: "Checks", parent: "tools-subagents" } };
  for (const n of g.nodes) if (n.id === "mail" || n.id === "card") n.group = "checks2";
  const whole = stepsDrawn(graphSvg(g));
  assert.ok(whole.includes("tools-subagents") && !whole.includes("checks2") && !whole.includes("mail"));
  const outer = graphSvg(g, { focus: "tools-subagents" });
  assert.ok(stepsDrawn(outer).includes("checks2"), "the nested group is a card inside its parent");
  assert.ok(!stepsDrawn(outer).includes("mail"));
  assert.ok(outer.includes('data-gopen="checks2"'));
  const inner = graphSvg(g, { focus: "checks2" });
  assert.deepEqual([...stepsDrawn(inner)].sort(), ["card", "mail"]);
  // Its wires come from the Tools step beside it in the parent, named as the parent draws it.
  assert.ok(inner.includes('data-gport="tools"'));
  assert.ok(inner.includes(">Tools &amp; subagents / Checks</b>"));
});

test("focus on one step draws it with what comes in, what it reads and what it gives out", () => {
  const html = graphSvg(main(), { focus: "fd" });
  assert.ok(html.includes('class="fcap"'));
  assert.ok(html.includes("Comes in") && html.includes("Gives out") && html.includes("Goes to"));
  assert.ok(html.includes(">Front door</b>"));
});

test("a focus that names nothing is one plain sentence", async () => {
  assert.throws(() => graphSvg(main(), { focus: "nope" }), /no step or group called "nope"/);
  const shots = { fetch: async () => assert.fail("nothing to photograph") };
  assert.deepEqual(await snapshotGraph({ SITE_SHOTS: shots }, main(), { focus: "nope" }), { ok: false, error: 'There is no step or group called "nope" in that graph.' });
});

test("the light theme is honoured", () => {
  assert.ok(graphSvg(main(), { theme: "light" }).includes('data-theme="light"'));
});

test("a changed step is ringed and a new one tagged, against a base", () => {
  const base = main();
  const draft = main();
  draft.nodes.find((n) => n.id === "fd").goal += " And be brief.";
  draft.nodes.push({ ...draft.nodes[0], id: "extra", label: "Extra step", x: 900, y: 700 });
  const html = graphSvg(draft, { base });
  const marks = [...html.matchAll(/<g class="mark (new|changed)" transform="translate\(([-\d.]+),([-\d.]+)\)"/g)];
  assert.deepEqual(marks.map((m) => m[1]).sort(), ["changed", "new"]);
  const at = (id) => html.match(new RegExp(`data-id="${id}" transform="translate\\(([-\\d.]+),([-\\d.]+)\\)"`)).slice(1, 3);
  assert.deepEqual(marks.find((m) => m[1] === "changed").slice(2, 4), at("fd"));
  assert.deepEqual(marks.find((m) => m[1] === "new").slice(2, 4), at("extra"));
  assert.ok(html.includes("1 step changed") && html.includes("1 new step"));
  assert.ok(!graphSvg(base, { base }).includes('class="mark'));
  assert.ok(graphSvg(base, { base }).includes("no difference from main"));
});

test("moving a step is not a change", () => {
  const base = main();
  const draft = main();
  draft.nodes.find((n) => n.id === "fd").x += 40;
  assert.ok(!graphSvg(draft, { base }).includes('class="mark'));
});

test("a step inside a folded group marks its box, and a removed step is named", () => {
  const base = main();
  const draft = main();
  const inside = draft.nodes.find((n) => n.id === "doorStep");
  assert.equal(inside.group, "intake");
  inside.ms += 100;
  const gone = draft.nodes.findIndex((n) => n.id === "learn");
  const name = draft.nodes[gone].label;
  draft.nodes.splice(gone, 1);
  draft.edges = draft.edges.filter((e) => e.from !== "learn" && e.to !== "learn");
  const html = graphSvg(draft, { base });
  const box = html.match(/<g class="mark changed" transform="translate\(([-\d.]+),([-\d.]+)\)"/);
  assert.ok(box, "the intake box is marked");
  assert.ok(html.includes(`removed: ${name}`));
});

function fakeShots(answer) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return typeof answer === "function" ? answer() : answer;
    },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the page goes to the picture renderer as static html and its png comes back", async () => {
  const shots = fakeShots(json({ png: "UE5H", width: 1600, height: 1064, blocked: [] }));
  const done = await snapshotGraph({ SITE_SHOTS: shots }, main(), { width: 1200 });
  assert.equal(shots.calls.length, 1);
  const { url, init, body } = shots.calls[0];
  assert.equal(url, "https://site-shots/render");
  assert.equal(init.method, "POST");
  assert.equal(body.width, 1200);
  assert.ok(body.height >= 200 && body.height <= 2400);
  assert.deepEqual(body.allow, []);
  assert.ok(body.html.startsWith("<!doctype html>") && body.html.includes("</html>"));
  assert.ok(body.html.includes("<svg") && !body.html.includes("<script"));
  assert.deepEqual(done, { ok: true, png: "UE5H", width: 1600, height: 1064 });
});

test("without the picture renderer there is one plain sentence", async () => {
  const none = { ok: false, error: "Snapshots are not set up on this deployment." };
  assert.deepEqual(await snapshotGraph({}, main()), none);
  assert.deepEqual(await snapshotGraph(undefined, main()), none);
  assert.deepEqual(await snapshotGraph({ SITE_SHOTS: {} }, main()), none);
});

test("a failing render gives one plain sentence, and never throws", async () => {
  const sentence = "The snapshot could not be drawn right now. Try again in a minute.";
  for (const answer of [json({ error: "busy" }, 503), json({ png: "UE5H" }, 502), json({ width: 1, height: 1 }), json({ png: "" }), new Response("not json", { status: 200 })]) {
    assert.deepEqual(await snapshotGraph({ SITE_SHOTS: fakeShots(answer) }, main()), { ok: false, error: sentence });
  }
  const broken = { fetch: async () => Promise.reject(new Error("connection reset")) };
  assert.deepEqual(await snapshotGraph({ SITE_SHOTS: broken }, main()), { ok: false, error: sentence });
});

test("a graph that is not a graph is one plain sentence", async () => {
  const shots = fakeShots(json({ png: "x" }));
  for (const bad of [null, {}, { nodes: [], edges: "no" }, { nodes: [{ id: "a" }], edges: [] }]) {
    const done = await snapshotGraph({ SITE_SHOTS: shots }, bad);
    assert.equal(done.ok, false);
    assert.match(done.error, /^[A-Z][^\n]*\.$/);
  }
  assert.equal(shots.calls.length, 0);
});
