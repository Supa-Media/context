/**
 * tex_dev's sandbox op `note_run` (`packages/tex/gateway/agent/noteRunLab.js`): a note's ask run on a draft's node, the
 * shelf's while nothing has one, for a note the caller can read; every line the app would stream, nothing logged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { labNoteRunNode, noteRunFromLab } from "../../../packages/tex/gateway/agent/noteRunLab.js";

const SESSION = {
  actorUserId: "u1",
  workspaceId: "wsA",
  workspaceSlug: "ana",
  workspaces: [
    { workspaceId: "wsA", slug: "ana", kind: "personal", role: "owner" },
    { workspaceId: "wsT", slug: "team", kind: "shared", role: "member" },
  ],
};
const NOTE = "projects/a.md";
const readOk = { content: [{ type: "text", text: `etag: @team/n1:e1\npath: ${NOTE}\nvisibility: team\n\nThe body.` }] };

function deps({ read = readOk, result = { outcome: "answered", answer: "Done.", replace: "New words.", sources: [NOTE], calls: [{ tool: "read_note" }], model: "m", usage: {}, ms: 5 } } = {}) {
  const seen = { calls: [], run: null };
  return {
    seen,
    dispatchFor: () => async (name, args) => (seen.calls.push({ name, args }), read),
    controlPlane: {},
    offered: [],
    ledger: null,
    runNoteRun: async (args) => {
      seen.run = args;
      args.onStep({ id: "step-1", label: "Reading a", state: "running", source: NOTE });
      return result;
    },
  };
}

describe("tex_dev note_run", () => {
  it("runs on the draft's node and answers every line the app would stream", async () => {
    const d = deps();
    const draftNode = { id: "noteRun", model: "sonnet-5-5", rounds: 3 };
    const out = await noteRunFromLab({ env: {}, store: {}, session: SESSION, args: { op: "note_run", draft: "v1", workspace: "@team", path: NOTE, ask: "Fix it" }, draftNode }, d);
    assert.equal(out.node.from, "draft");
    assert.equal(d.seen.run.node, draftNode);
    assert.equal(d.seen.run.workspace, "@team");
    assert.deepEqual(out.lines.map((l) => l.type), ["step", "answer", "edit", "done"]);
    assert.deepEqual(d.seen.calls, [{ name: "read_note", args: { path: NOTE, context: "@team" } }]);
  });

  it("falls back to the shelf's definition while neither the draft nor main has the node", () => {
    const { node, from } = labNoteRunNode({}, null);
    assert.equal(from, "shelf");
    assert.equal(node.id, "noteRun");
  });

  it("refuses a workspace the caller is not in, and a note it cannot read, before any run", async () => {
    const d = deps();
    const stranger = await noteRunFromLab({ env: {}, store: {}, session: SESSION, args: { workspace: "wsZ", path: NOTE, ask: "hi" } }, d);
    assert.match(stranger.error, /no access/);
    const hidden = deps({ read: { isError: true, content: [] } });
    const unread = await noteRunFromLab({ env: {}, store: {}, session: SESSION, args: { workspace: "@team", path: NOTE, ask: "hi" } }, hidden);
    assert.match(unread.error, /can't be read/);
    assert.equal(d.seen.run, null);
    assert.equal(hidden.seen.run, null);
  });

  it("says a run that did not answer as one error line", async () => {
    const d = deps({ result: { outcome: "daily_limit" } });
    const out = await noteRunFromLab({ env: {}, store: {}, session: SESSION, args: { workspace: "@team", path: NOTE, ask: "hi" } }, d);
    assert.deepEqual(out.lines.at(-1), { type: "error", message: "daily_limit" });
    assert.equal(out.lines.some((l) => l.type === "answer"), false);
  });
});
