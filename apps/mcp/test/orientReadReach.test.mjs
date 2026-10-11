/**
 * `orient` reads other workspaces' front pages (#1508), so the egress ledger
 * has to hear about every one of them.
 *
 * `privacy/egress.js` decides whether a widening needs a person by asking what
 * this turn read: a read from a workspace other than the one being widened
 * always asks. `search_notes` reports its fan-out through `withReadReach`
 * (row 668). Orient's fan-out is the same shape — one call, several
 * workspaces' note text — and reported nothing, so a turn that held another
 * workspace's front page could widen inside a team-tier workspace unasked.
 *
 * Only a workspace whose front page actually rendered counts, for the reason
 * `search.js`'s `reachOf` gives: a workspace that handed the model nothing was
 * not read, and recording it would make the gate ask about a read that never
 * happened.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { surveyOtherContexts, toolOrient } from "../src/orient/tool.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";
import { approvalRequired, newLedger, recordRead, readReachOf, withReadReach } from "../src/privacy/egress.js";

const MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function memoryStore(files) {
  return { get: async (key) => (key in files ? { text: async () => files[key] } : null) };
}

const withFrontPage = (title) => memoryStore({ "privacy.md": MANIFEST, "index.md": `# ${title}\n\nThe plan.\n` });

const CONTEXTS = [
  { name: "@mine", current: true, role: "owner" },
  { name: "@band", role: "member" },
  { name: "@broken", role: "member" },
  { name: "@shut", role: "member" },
  { name: "@empty", role: "member" },
];

const OPENS = {
  "@band": { session: { scope: "private", workspaceId: "ws_band" }, store: withFrontPage("Band") },
  // A manifest that cannot be parsed: the section says so and shows no notes.
  "@broken": {
    session: { scope: "team", workspaceId: "ws_broken" },
    store: { get: async (key) => (key === "privacy.md" ? { text: async () => { throw new Error("torn"); } } : null) },
  },
  // Visible, but nothing in it this caller may see.
  "@empty": { session: { scope: "team", workspaceId: "ws_empty" }, store: memoryStore({ "privacy.md": MANIFEST }) },
};

const openContext = async (name) => {
  const opened = OPENS[name];
  if (!opened) throw new Error("storage disconnected");
  return opened;
};

test("orient's fan-out reports every workspace whose front page it handed over, and no others", async () => {
  const { section, reached } = await surveyOtherContexts({ contexts: CONTEXTS }, openContext);

  assert.match(section, /@band/, "the section still renders");
  assert.match(section, /The plan\./, "including the front page it read");
  assert.deepEqual(reached, [{ workspaceId: "ws_band", scope: "private" }]);
});

test("a fan-out with no openContext reads nothing and reports nothing", async () => {
  const { reached } = await surveyOtherContexts({ contexts: CONTEXTS }, null);
  assert.deepEqual(reached, [], "an orient addressed into another context does not chain");
});

test("the ledger hears orient's reach, so a team-tier turn cannot widen on it unasked", async () => {
  const { reached } = await surveyOtherContexts({ contexts: CONTEXTS }, openContext);
  const result = withReadReach({ content: [{ type: "text", text: "orient" }] }, reached);
  assert.deepEqual(readReachOf(result), [{ workspaceId: "ws_band", scope: "private" }]);

  // A session that is not the owner of the workspace it is addressed to reads
  // it at the team tier, so its own read alone never forces the question.
  const ledger = newLedger();
  recordRead(ledger, { name: "orient", args: {}, scope: "team", workspaceId: "ws_mine", result });
  assert.equal(
    approvalRequired({ complete: true, ledger }, { audience: "team", summary: "" }, "ws_mine"),
    true,
    "another workspace's front page is held: ask before widening here"
  );

  // And what the reporting is load-bearing against: the same turn with the
  // fan-out unreported reads as a turn that only ever saw its own team-tier
  // workspace, and widening there would not ask.
  const blind = newLedger();
  recordRead(blind, { name: "orient", args: {}, scope: "team", workspaceId: "ws_mine", result: { content: [{ type: "text", text: "orient" }] } });
  assert.equal(
    approvalRequired({ complete: true, ledger: blind }, { audience: "team", summary: "" }, "ws_mine"),
    false,
    "an unreported fan-out is a widening nobody is asked about"
  );
});

test("the whole orient result carries its reach, not just the section that made it", async () => {
  // The wiring, end to end: `callToolForSession` reads the reach off the
  // result object `toolOrient` returns, so reporting it anywhere short of
  // there reports it nowhere.
  const files = { "privacy.md": MANIFEST, "index.md": "# Mine\n\nHere.\n" };
  const here = {
    get: async (key) => (key in files ? { text: async () => files[key] } : null),
    list: async () => ({ objects: [{ key: "index.md", size: 10, uploaded: new Date() }], truncated: false }),
    contexts: [
      { name: "@mine", current: true, role: "owner" },
      { name: "@band", role: "member" },
    ],
    openContext: async () => ({
      session: { scope: "private", workspaceId: "ws_band" },
      store: { ...withFrontPage("Band"), list: async () => ({ objects: [], truncated: false }) },
    }),
  };
  const { rules, overrides } = parsePrivacyManifest(MANIFEST);
  const result = await toolOrient(here, "team", rules, overrides);

  assert.match(result.content[0].text, /@band/, "the section is in the answer");
  assert.deepEqual(readReachOf(result), [{ workspaceId: "ws_band", scope: "private" }]);
});
