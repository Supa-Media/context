/**
 * tex_dev's checks on a Lab draft that holds search's steps beside Tex's (Dev2, 2026-11-21). Tex's checks read Tex's
 * side only; search's steps are checked against search's own schema and compared with search's config.
 *
 * Sabotage record (temporary local edits, reverted):
 *   draftProblems running on the whole draft (search's steps as Tex's)   "a search step is not a Tex step" fails
 *   draftProblems not calling searchConfigProblems                        "search's bounds are checked" fails
 *   searchVsMain answering [] always                                      "a search setting change is named" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { draftProblems, draftVsMain } from "../../../packages/lab/gateway/texDev/check.js";
import { labSearchGraph } from "../src/search/config/labDraft.cjs";

const draftWith = (mutate = () => {}) => {
  const search = labSearchGraph();
  const graph = { nodes: [...structuredClone(TEX_CONFIG.nodes), ...search.nodes], edges: [...structuredClone(TEX_CONFIG.edges), ...search.edges] };
  mutate(graph);
  return graph;
};
const fuse = (g) => g.nodes.find((n) => n.id === "fuse");

test("a draft with search's steps passes when they are as search has them", () => {
  assert.deepEqual(draftProblems(draftWith()), []);
});

test("search's steps are checked by search's schema, named Search", () => {
  const problems = draftProblems(draftWith((g) => {
    fuse(g).settings = { ...fuse(g).settings, hits: 99 };
  }));
  assert.ok(problems.some((p) => p.startsWith("Search: ") && /hits must be from 1 to 50/.test(p)), problems.join("\n"));
  assert.equal(problems.filter((p) => !p.startsWith("Search: ")).length, 0);
});

test("Tex's checks never see search's steps: a search step with no Tex code is not a Tex problem", () => {
  const problems = draftProblems(draftWith((g) => {
    fuse(g).model = "not-a-model";
  }));
  assert.equal(problems.some((p) => /"fuse"/.test(p) && !p.startsWith("Search: ")), false, problems.join("\n"));
});

test("a setting change against search's config is named with its numbers, and on or off changes too", () => {
  const diff = draftVsMain(draftWith((g) => {
    fuse(g).settings = { ...fuse(g).settings, hits: 8 };
    g.nodes.find((n) => n.id === "each").on = false;
  }));
  assert.ok(diff.own.includes("Search · Rank across workspaces: hits 12 → 8"), diff.own.join("\n"));
  assert.ok(diff.own.includes("Search · Search each workspace: turned off"), diff.own.join("\n"));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, {});
});

test("a draft with no search steps has no search lines, and search's steps are not Tex's added steps", () => {
  const plain = draftVsMain({ nodes: structuredClone(TEX_CONFIG.nodes), edges: structuredClone(TEX_CONFIG.edges) });
  assert.deepEqual(plain.own, []);
  const withSearch = draftVsMain(draftWith());
  assert.deepEqual(withSearch.own, []);
  assert.deepEqual(withSearch.added, []);
});
