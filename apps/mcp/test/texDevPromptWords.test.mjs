/**
 * A Tex prompt's words are a Lab draft edit (docs/lab.md, rungs 1-3): `tex_dev edit { op: "module", key: "p-<name>",
 * value: { text } }` on a draft made from main (here the control plane's edit is stood in for), then the same words reach every place the draft runs and lands: the
 * Lab's Modules and get's vsMain, a test chat (`withDraft`, what send/try/replay/again run the turn on), a Dev run
 * (the workflow promotes the draft's graph into the checkout with `tex-lab-promote.mjs`, kind "dev" and "node"
 * alike), Promote's pull request (the words written into packages/tex/src/texPrompt/), and the merge onto a main that
 * moved (a clash when main changed the same words).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-23).
 *
 *  1. `shownGraph` (engine/state.ts) without `withStepDefaults`. → "a draft made from main lists and diffs its edited
 *     prompt words" fails (a search step has no ctx).
 *  2. `draftWords` (texConfig.js) skipping every module. → "the draft's words are what a test chat's turn reads" fails.
 *  3. `configFrom` (tex-lab-promote.mjs) dropping `words`. → "a run and Promote write the draft's words" fails.
 *  4. `mergeOntoMain` (tex-lab-merge.mjs) not pushing the words clash. → "a main that changed the same words clashes"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { withDraft } from "../../../packages/tex/gateway/agent/graph/turnGraph.js";
import { draftFit, TEX_CONFIG, texWords } from "../../../packages/tex/gateway/agent/texConfig.js";
import { configFrom, mergeDraft } from "../../../scripts/tex-lab-promote.mjs";
import { joinedTexConfig } from "../../../scripts/lib/texConfigFile.mjs";
import { wordsOf } from "../../../scripts/tex-prompt-module.mjs";

const NAME = "how-you-talk";
const KEY = `p-${NAME}`;
const LINE = "- End every text with the word PINEAPPLE.";
const MAIN_WORDS = wordsOf();
const DRAFT_TEXT = `${MAIN_WORDS[NAME]}\n\n${LINE}`;

const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));

/** A control plane holding one draft: create keeps the graph tex_dev sends; edit applies a module op, as the plane does. */
function onePlane() {
  let row = null;
  return {
    get graph() {
      return JSON.parse(row.graph);
    },
    async texDev(_token, action, args) {
      if (action === "create") {
        row = { status: "ok", name: args.name, by: "@dev", rev: 1, graph: args.graph, picks: "{}", areas: null, results: "[]" };
        return { status: "ok", id: "vwords", rev: 1 };
      }
      if (action === "get") return row;
      if (action === "edit") {
        const g = JSON.parse(row.graph);
        for (const op of args.ops) if (op.op === "module") g.modules = { ...g.modules, [op.key]: op.value };
        row = { ...row, graph: JSON.stringify(g), rev: row.rev + 1 };
        return { status: "ok", rev: row.rev };
      }
      return { status: "ok", caseEdits: [] };
    },
  };
}

/** The draft as an agent makes it: `create` from main (Tex's steps beside the search steps), then one module edit. */
async function draftWithWords() {
  const plane = onePlane();
  const dev = (action, args) => createTexDev({ env: {}, session: { accessToken: "tok" }, controlPlane: plane })(action, args);
  const made = await dev("create", { name: "words" });
  assert.notEqual(made.isError, true, textOf(made));
  assert.ok(plane.graph.nodes.some((n) => !Array.isArray(n.ctx)), "main as create sends it has steps with no ctx (the search steps)");
  const edited = await dev("edit", { draft: "vwords", rev: 1, ops: [{ op: "module", key: KEY, value: { text: DRAFT_TEXT } }] });
  assert.notEqual(edited.isError, true, textOf(edited));
  return { dev, graph: plane.graph };
}

test("a draft made from main lists and diffs its edited prompt words", async () => {
  const { dev, graph } = await draftWithWords();
  assert.equal(graph.modules[KEY].text, DRAFT_TEXT);
  const list = jsonOf(await dev("modules", { draft: "vwords" }));
  const row = list.flatMap((s) => s.modules).find((m) => m.key === KEY);
  assert.equal(row.pill, "edited");
  assert.ok(row.usedBy.length > 0, "the steps that read it are named");
  const one = jsonOf(await dev("modules", { draft: "vwords", key: KEY }));
  assert.equal(one.text, DRAFT_TEXT);
  assert.ok(one.diff.some(([k, w]) => k === "+" && w.includes("PINEAPPLE")));
  const got = jsonOf(await dev("get", { draft: "vwords" }));
  assert.ok(JSON.stringify(got.vsMain).includes(KEY), "get's vsMain names the edited module");
});

test("the draft's words are what a test chat's turn reads, and main's are untouched", async () => {
  const { graph } = await draftWithWords();
  assert.equal(draftFit(TEX_CONFIG, graph).asDrawn, true);
  assert.equal(texWords(withDraft(TEX_CONFIG, graph))[NAME], DRAFT_TEXT);
  assert.equal(texWords(TEX_CONFIG)[NAME], MAIN_WORDS[NAME]);
});

test("a run and Promote write the draft's words into packages/tex/src/texPrompt/, and only the changed ones", async () => {
  const { graph } = await draftWithWords();
  const made = configFrom(graph, joinedTexConfig(), MAIN_WORDS);
  assert.ok(made.config, made.reason);
  assert.deepEqual(made.words, { [NAME]: DRAFT_TEXT });
});

test("a main that changed the same words clashes, and a pick settles it", async () => {
  const { graph } = await draftWithWords();
  const config = joinedTexConfig();
  const side = (words) => ({ config, words, shelf: [] });
  const main = side({ ...MAIN_WORDS, [NAME]: `${MAIN_WORDS[NAME]}\n\nMain's line.` });
  const found = { commit: "c0ffee0", guessed: false };
  const clash = mergeDraft({ graph, found, base: side(MAIN_WORDS), main });
  assert.equal(clash.clashes.length, 1);
  assert.match(clash.clashes[0].what, new RegExp(`words of prompt module ${NAME}`));
  const draft = mergeDraft({ graph, found, base: side(MAIN_WORDS), main, picks: { [clash.clashes[0].what]: "draft" } });
  assert.equal(draft.words[NAME], DRAFT_TEXT);
  const kept = mergeDraft({ graph, found, base: side(MAIN_WORDS), main, picks: { [clash.clashes[0].what]: "main" } });
  assert.equal(kept.words[NAME], undefined);
  const untouched = mergeDraft({ graph, found, base: side(MAIN_WORDS), main: side(MAIN_WORDS) });
  assert.deepEqual([untouched.clashes?.length ?? 0, untouched.words[NAME]], [0, DRAFT_TEXT]);
});
