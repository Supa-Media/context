/**
 * THE GATEWAY READS THE CONVEX TREE'S FACTS (`tree/facts.js`).
 *
 * A move's link rewrite and `orient`'s chaos score ask `/gateway/tree/facts`
 * before the search database, and fall back to it, or to a walk, whenever the
 * facts cannot answer. Decided by the owner, 2026-10-13.
 *
 * Sabotage-checked: dropping the renamed notes' own destinations from
 * `factCandidates` fails "a move's candidates"; recording today's score for a
 * team reader fails "only an owner's private read keeps today's score";
 * spreading the request after the token fails "the call spends the person's
 * token".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { R2Store } from "../src/store/r2.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { loadPrivacyState } from "../src/privacy/state.js";
import { factCandidates, factChaos } from "../src/tree/facts.js";
import { referenceCandidates, rewriteReferences } from "../src/tools/moves/references.js";
import { factSection } from "../src/chaos/orient.js";
import { liveSummary, scoreKeys } from "../src/chaos/live.js";
import { createTreeMethods } from "../src/controlPlane/tree.js";

const renames = new Map([["1-projects/launch/plan.md", "3-resources/plan.md"]]);

function factStore(answer, asked = []) {
  return {
    treeFacts: async (request) => {
      asked.push(request);
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(request) : answer;
    },
  };
}

test("a move's candidates: pointing and unparsed notes at their new names, and the moved notes themselves", async () => {
  const asked = [];
  const store = factStore(
    { served: true, candidates: { pointing: ["1-projects/launch/brief.md", "1-projects/launch/plan.md"], unparsed: ["2-areas/x.md"] } },
    asked,
  );
  const found = await factCandidates(store, renames);
  assert.deepEqual([...found].sort(), ["1-projects/launch/brief.md", "2-areas/x.md", "3-resources/plan.md"]);
  assert.deepEqual(asked, [{ ask: "links", sources: ["1-projects/launch/plan.md"], names: ["plan"] }]);
});

test("no facts, no answer: the caller falls back", async () => {
  assert.equal(await factCandidates({}, renames), null);
  assert.equal(await factCandidates(factStore({ served: false }), renames), null);
  assert.equal(await factCandidates(factStore({ served: true, candidates: null }), renames), null);
  assert.equal(await factCandidates(factStore(new Error("down")), renames), null);
  assert.equal(await factCandidates(factStore({ served: true, candidates: { pointing: [] } }), new Map()), null);
});

test("a rewrite reads only the notes the facts name, listed from the tree, with no search database", async () => {
  const raw = memoryBucket();
  await raw.put("3-resources/plan.md", "# Plan\n\nSee [the brief](./brief.md).\n");
  await raw.put("1-projects/launch/brief.md", "# Brief\n\nBack to [[plan]].\n");
  await raw.put("1-projects/launch/unrelated.md", "# Unrelated\n");
  const store = Object.create(new R2Store(raw));
  Object.defineProperty(store, "treeManifest", {
    value: async () => ({
      served: true,
      entries: [{ path: "1-projects/launch/brief.md" }, { path: "1-projects/launch/plan.md" }, { path: "1-projects/launch/unrelated.md" }],
      cursor: null,
    }),
    enumerable: false,
  });
  Object.defineProperty(store, "treeFacts", {
    value: async () => ({ served: true, candidates: { pointing: ["1-projects/launch/brief.md"], unparsed: [] } }),
    enumerable: false,
  });
  const options = await referenceCandidates(store, renames);
  assert.deepEqual([...options.candidates].sort(), ["1-projects/launch/brief.md", "3-resources/plan.md"]);
  assert.ok(options.inventoryKeys.includes("3-resources/plan.md"));
  assert.ok(!options.inventoryKeys.includes("1-projects/launch/plan.md"));
  const read = [];
  const get = raw.get.bind(raw);
  raw.get = async (key, ...rest) => {
    if (key.endsWith(".md") && !key.startsWith(".") && key !== "privacy.md") read.push(key);
    return get(key, ...rest);
  };
  const state = await loadPrivacyState(store);
  const result = await rewriteReferences(store, "private", state.rules, state.overrides, renames, options);
  assert.equal(result.notes, 1);
  assert.ok(!read.includes("1-projects/launch/unrelated.md"), "a note the facts did not name is not read");
  assert.match(await (await raw.get("3-resources/plan.md")).text(), /\]\(\.\.\/1-projects\/launch\/brief\.md\)/);
});

const extras = [{ path: "1-projects/big/novel.md", lines: 1500, exempt: false, review: false }];
const keys = [
  ...["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((word) => `1-projects/big/${word}.md`),
  "1-projects/big/novel.md",
  "2-areas/private/secret.md",
];

test("orient's chaos from the facts is the keys' count with the facts' extras and week", async () => {
  const asked = [];
  const store = {
    treeKeys: async () => keys,
    ...factStore({ served: true, chaos: { extras, weekAgo: 42 } }, asked),
  };
  const section = await factSection(store, "team", () => true, [], new Map());
  const map = new Map(extras.map(({ path, ...extra }) => [path, extra]));
  // With no rules everything is private, so the team counts nothing; compare like with like.
  const expected = liveSummary(scoreKeys(keys, map, () => false), map, { team: true, present: new Set(keys), visible: () => true, limit: 4, weekAgo: 42 });
  assert.deepEqual(section, expected);
  assert.equal(section.weekAgo, 42);
  assert.deepEqual(asked, [{ ask: "chaos" }]);
});

test("only an owner's private read keeps today's score", async () => {
  const deferred = [];
  const asked = [];
  const store = {
    treeKeys: async () => keys,
    defer: (work) => deferred.push(work),
    ...factStore({ served: true, chaos: { extras, weekAgo: null } }, asked),
  };
  await factSection(store, "team", () => true, [], new Map());
  assert.equal(deferred.length, 0);
  await factSection(store, "all", () => true, [], new Map());
  assert.equal(deferred.length, 1);
  await deferred[0]();
  const kept = asked.at(-1);
  assert.equal(kept.ask, "chaos");
  assert.ok(Number.isFinite(kept.today.all) && Number.isFinite(kept.today.team));
});

test("orient's chaos falls back where the facts cannot answer", async () => {
  assert.equal(await factSection({ treeKeys: async () => keys }, "all", () => true, [], new Map()), null);
  assert.equal(await factSection({ treeKeys: async () => null, ...factStore({ served: true, chaos: { extras, weekAgo: null } }) }, "all", () => true, [], new Map()), null);
  assert.equal(await factSection({ treeKeys: async () => keys, ...factStore({ served: true, chaos: null }) }, "all", () => true, [], new Map()), null);
  assert.equal(await factChaos(factStore(new Error("down"))), null);
});

test("the call spends the person's token, which nothing in the request can replace", async () => {
  const sent = [];
  let answer = { served: true, candidates: { pointing: [], unparsed: [] } };
  const methods = createTreeMethods({
    post: async (path, body) => {
      sent.push({ path, body });
      return answer;
    },
  });
  const request = { ask: "links", sources: ["a.md"], names: ["a"], accessToken: "someone-else", expectedWorkspaceId: "ws_2" };
  assert.deepEqual(await methods.readTreeFacts("tok", "ws_1", request), answer);
  assert.deepEqual(sent[0], {
    path: "/gateway/tree/facts",
    body: { ask: "links", sources: ["a.md"], names: ["a"], accessToken: "tok", expectedWorkspaceId: "ws_1" },
  });
  answer = { served: false, extra: "x" };
  assert.deepEqual(await methods.readTreeFacts("tok", "ws_1", { ask: "chaos" }), { served: false });
});
