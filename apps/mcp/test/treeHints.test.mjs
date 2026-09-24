/**
 * WHAT THE GATEWAY TELLS THE CONTROL PLANE WHEN AN AGENT CHANGES THE TREE.
 *
 * An agent creating, moving or re-scoping a note has to reach the consoles
 * showing that context, so they re-list it. What crosses the boundary is a
 * workspace id and audience labels — `private`, `team`, `@name` — and nothing
 * else, and a label is sent only for an audience that can see the change: a
 * timestamp served to anybody else would date a private note for them.
 * Sabotage-checked: sending labels for every write fails "an edit to an
 * existing note sends nothing"; judging a move's source after the move fails
 * "a note held back from a shared folder moves without telling the team".
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

export async function runTreeHintChecks(check) {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  const bucket = {
    async get(key) {
      if (!objects.has(key)) return null;
      const { bytes, etag } = objects.get(key);
      return {
        etag,
        size: bytes.length,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    async head(key) {
      if (!objects.has(key)) return null;
      const { bytes, etag } = objects.get(key);
      return { etag, size: bytes.length };
    },
    async put(key, value, options = {}) {
      const current = objects.get(key);
      const wanted = options.onlyIf;
      if (wanted?.etagMatches && current?.etag !== wanted.etagMatches) return null;
      if (wanted?.absent && current) return null;
      const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
      const etag = `e${++etagCounter}`;
      objects.set(key, { bytes, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix } = {}) {
      const listed = [...objects.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({
          key,
          size: objects.get(key).bytes.length,
          uploaded: new Date(),
          etag: objects.get(key).etag,
        }));
      return { objects: listed, truncated: false };
    },
  };

  const store = new R2Store(bucket);
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    controlPlane.addWorkspace("ws_tree", "tree", {
      provider: "r2-binding",
      bindingName: "CONTEXT_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    const OWNER = "cat_test_tree_owner_00000000000000000";
    await controlPlane.addGrant({
      accessToken: OWNER,
      workspaceId: "ws_tree",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_tree_owner",
      clientName: "Claude Code",
      userId: "user_tree_owner",
    });
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "CONTEXT_BUCKET",
      CONTEXT_BUCKET: bucket,
    };

    let id = 0;
    async function call(name, args = {}) {
      const deferred = [];
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        env,
        { waitUntil: (work) => deferred.push(work) },
      );
      const result = (await res.json()).result;
      await Promise.allSettled(deferred);
      return result;
    }
    /** The labels each `/gateway/tree` call since the last `reset` carried. */
    const hints = () =>
      controlPlane.calls
        .filter((entry) => entry.path === "/gateway/tree")
        .map((entry) => entry.body);
    const reset = () => {
      controlPlane.calls.length = 0;
    };

    await store.put(
      "privacy.md",
      "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n" +
        "```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  1-projects: team\n" +
        "  2-areas: private\n\nnote_overrides:\n  1-projects/pay.md: private\n```\n\n" +
        "<!-- END BRAIN PRIVACY RULES -->\n",
    );
    await store.put("1-projects/pay.md", "# Pay\n");

    reset();
    const created = await call("write_note", {
      path: "1-projects/launch.md",
      content: "# Launch\n",
      visibility: "team",
      confirm_team_publish: true,
    });
    check("an agent's create still succeeds", !created?.isError);
    check(
      "a shared note's creation tells the owner and the team, and says nothing else",
      JSON.stringify(hints()) ===
        JSON.stringify([{ workspaceId: "ws_tree", audiences: ["private", "team"] }]),
    );

    reset();
    await call("write_note", { path: "2-areas/health.md", content: "# Health\n" });
    check(
      "a private note's creation tells the owner alone",
      JSON.stringify(hints()) === JSON.stringify([{ workspaceId: "ws_tree", audiences: ["private"] }]),
    );

    reset();
    const read = await call("read_note", { path: "1-projects/launch.md" });
    const etag = /etag: (\S+)/.exec(read?.content?.[0]?.text ?? "")?.[1];
    await call("write_note", {
      path: "1-projects/launch.md",
      content: "# Launch\n\nMore.\n",
      ...(etag ? { expected_etag: etag } : {}),
    });
    check("an edit to an existing note sends nothing", hints().length === 0);

    reset();
    await call("move_note", { source: "1-projects/pay.md", destination: "2-areas/pay.md" });
    check(
      "a note held back from a shared folder moves without telling the team",
      hints().length === 1 && !hints()[0].audiences.includes("team"),
    );

    reset();
    const proposed = await call("propose_note", {
      path: "1-projects/suggested.md",
      content: "# Suggested\n",
      reason: "An agent thinks this belongs here",
      agent: "Claude Code",
    });
    const proposalId = /proposal queued: ([0-9a-f-]+)/i.exec(proposed?.content?.[0]?.text ?? "")?.[1];
    check("a proposal waits outside the tree, so nobody is told yet", hints().length === 0);
    const approved = await call("review_proposal", { id: proposalId, action: "approve" });
    check(
      "approving a proposal puts a note in the tree, and tells the owner alone, even in a shared folder",
      !approved?.isError &&
        JSON.stringify(hints()) === JSON.stringify([{ workspaceId: "ws_tree", audiences: ["private"] }]),
    );

    reset();
    await call("move_note", { source: "1-projects/launch.md", destination: "2-areas/launch.md" });
    check(
      "a shared note moved somewhere private still tells the team it went",
      hints().length === 1 && hints()[0].audiences.includes("team"),
    );
  } finally {
    restore();
  }
}
