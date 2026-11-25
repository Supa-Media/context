/**
 * `manage area` `attach` and `detach` (`src/tools/notes/attachProjects.js`): which projects serve an area, as one
 * `area:` line in each project's front note, the line the app's area panel writes (the owner, 2026-11-25). The
 * promises: attach writes the area's folder into the project's own front note (making `about.md` only when it has
 * none) and touches nothing else; one project, one area, so attaching moves it; detach removes the line only when it
 * names this area or one inside it; a folder outside the Projects folder is refused; and a project this connection
 * cannot see is answered exactly like one that is not there.
 *
 * ## Sabotage record
 *
 * Detaching whatever area the line named failed "detach leaves a project serving another area alone". Skipping the
 * visibility filter failed "a project this connection cannot see answers like a missing one". Reading only
 * `store.treeEntries` (which a tool call's store does not have: production answered "map cannot be read") failed "a
 * tool call's store ... attaches too".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolSetArea } from "../src/tools/notes/setArea.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { noteProperties } from "../src/lists/properties.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [
  { prefix: "areas", vis: "team" },
  { prefix: "projects", vis: "team" },
  { prefix: "projects/secret", vis: "private" },
];

async function world(notes, { manifest = false } = {}) {
  const base = createMemoryStore();
  for (const [key, text] of Object.entries(notes)) await base.put(key, text);
  const folders = RULES.map(({ prefix, vis }) => ({ prefix, visibility: vis }));
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders, notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = { workspaceId: "ws-test", workspaceKind: "shared", role: "owner" };
  const served = store.treeFacts;
  store.treeFacts = async (request) =>
    request.ask === "jobs" ? { served: true, jobs: { areas: "areas", projects: "projects" }, roots: ["areas", "projects"] } : served(request);
  if (manifest) {
    // A tool call's store, as production hands it: no treeEntries, only the Convex tree's manifest.
    Object.defineProperty(store, "treeManifest", {
      value: async () => ({ served: true, entries: (await base.list({})).objects.map(({ key }) => ({ path: key })), cursor: null }),
      configurable: true,
    });
  } else {
    store.treeEntries = async () => (await base.list({})).objects;
  }
  const text = async (key) => (await (await base.get(key))?.text()) ?? null;
  const props = async (key) => noteProperties((await text(key)) ?? "");
  return { store, text, props };
}

const run = (store, args, scope = "team") => toolSetArea(store, scope, RULES, new PrivacyOverrides(), args);
const said = (result) => result.content.map((part) => part.text).join("\n");

const NOTES = {
  "areas/finance/about.md": "---\nowner: \"@seyi\"\n---\n\n# Finance\n",
  "areas/finance/payroll/about.md": "---\narea: true\n---\n\n# Payroll\n",
  "areas/design/about.md": "---\nowner: \"@sayo\"\n---\n\n# Design\n",
  "projects/website/about.md": "---\nstatus: In progress\n---\n\n# Website\n\nThe new site.\n",
  "projects/pricing/README.md": "---\nstatus: Not started\narea: areas/design\n---\n\n# Pricing\n",
  "projects/loose/plan.md": "# Plan\n",
  "projects/run-payroll/about.md": "---\nstatus: In progress\narea: areas/finance/payroll\n---\n\n# Run payroll\n",
  "projects/secret/about.md": "---\nstatus: In progress\n---\n\n# Secret\n",
  "inbox/thing/about.md": "# Thing\n",
};

test("attach writes the area into each project's own front note and keeps the rest of it", async () => {
  const { store, text, props } = await world(NOTES);
  const result = await run(store, { area: "areas/finance", attach: ["projects/website", "projects/pricing"] });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await props("projects/website/about.md")).area, "areas/finance");
  assert.match(await text("projects/website/about.md"), /status: In progress[\s\S]*The new site\./);
  // A README front note is written in place, and the project moves from Design: one project, one area.
  assert.equal((await props("projects/pricing/README.md")).area, "areas/finance");
  assert.equal(await text("projects/pricing/about.md"), null);
  assert.match(said(result), /projects\/website: now serves areas\/finance/);
});

test("a project with no front note gets an about.md holding the line", async () => {
  const { store, props } = await world(NOTES);
  const result = await run(store, { area: "areas/finance", attach: "projects/loose/" });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await props("projects/loose/about.md")).area, "areas/finance");
});

test("detach removes the line when it names this area or one inside it", async () => {
  const { store, props } = await world(NOTES);
  const result = await run(store, { area: "areas/finance", detach: "projects/run-payroll" });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await props("projects/run-payroll/about.md")).area, undefined);
  assert.equal((await props("projects/run-payroll/about.md")).status, "In progress");
});

test("detach leaves a project serving another area alone, and says so", async () => {
  const { store, props } = await world(NOTES);
  const result = await run(store, { area: "areas/finance", detach: "projects/pricing" });
  assert.equal((await props("projects/pricing/README.md")).area, "areas/design");
  assert.match(said(result), /not done: projects\/pricing serves areas\/design, not areas\/finance/);
});

test("a folder outside the Projects folder is not a project", async () => {
  const { store, props } = await world(NOTES);
  const result = await run(store, { area: "areas/finance", attach: "inbox/thing" });
  assert.match(said(result), /inbox\/thing is not a project/);
  assert.equal((await props("inbox/thing/about.md")).area, undefined);
});

test("a project this connection cannot see answers like a missing one, and is not written", async () => {
  const { store, props } = await world(NOTES);
  const hidden = said(await run(store, { area: "areas/finance", attach: "projects/secret" }));
  const missing = said(await run(store, { area: "areas/finance", attach: "projects/nothing" }));
  assert.equal(hidden.replaceAll("projects/secret", "X"), missing.replaceAll("projects/nothing", "X"));
  assert.equal((await props("projects/secret/about.md")).area, undefined);
  // The owner can.
  const owner = await run(store, { area: "areas/finance", attach: "projects/secret" }, "private");
  assert.equal(owner.isError, undefined, said(owner));
  assert.equal((await props("projects/secret/about.md")).area, "areas/finance");
});

test("an area that is not there is refused before anything is written", async () => {
  const { store, props } = await world(NOTES);
  const result = await run(store, { area: "areas/nowhere", attach: "projects/website" });
  assert.equal(result.isError, true);
  assert.equal((await props("projects/website/about.md")).area, undefined);
});

test("a tool call's store, which lists names only through the tree's manifest, attaches too", async () => {
  const { store, props } = await world(NOTES, { manifest: true });
  assert.equal(typeof store.treeEntries, "undefined");
  const result = await run(store, { area: "areas/finance", attach: "projects/website" });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await props("projects/website/about.md")).area, "areas/finance");
});
