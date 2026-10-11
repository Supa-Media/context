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

    /*
      A FRONT MATTER CHANGE DOES, because a project List is drawn from it.

      Reported 2026-10-07: an agent made a folder a project and set statuses,
      and the Projects List went on showing the old values until the
      console's five-minute pass. Sabotage-checked: gating on TREE_ACTIONS
      alone fails "an agent changing a note's status tells the consoles".
    */
    const fm = async (content) => {
      const current = await call("read_note", { path: "1-projects/status.md" });
      const tag = /etag: (\S+)/.exec(current?.content?.[0]?.text ?? "")?.[1];
      return await call("write_note", { path: "1-projects/status.md", content, ...(tag ? { expected_etag: tag } : {}) });
    };
    await call("write_note", {
      path: "1-projects/status.md",
      content: "---\nstatus: to do\n---\n\n# Status\n",
      visibility: "team",
      confirm_team_publish: true,
    });
    reset();
    await fm("---\nstatus: in progress\n---\n\n# Status\n");
    check(
      "an agent changing a note's status tells the consoles, at the note's own audiences",
      JSON.stringify(hints()) === JSON.stringify([{ workspaceId: "ws_tree", audiences: ["private", "team"] }]),
    );
    reset();
    await fm("---\nstatus: in progress\n---\n\n# Status\n\nA line of body.\n");
    check("a body edit under unchanged front matter still sends nothing", hints().length === 0);

    /*
      A REWRITE THAT DROPPED THE FIRST `---` GETS IT BACK, AND IS TOLD.

      The 2026-10-07 case: a client rewrote @supa's context-agent overview as
      `updated: …\nstatus: in progress\n…\n---`, and the project fell into
      the List's Notes section. Sabotage-checked: without the repair, "the
      stored note opens with its front matter again" fails.
    */
    reset();
    const dropped = await fm("updated: 2026-10-07\nstatus: finished\ntags: [context]\n---\n\n# Status\n");
    const droppedText = dropped?.content?.[0]?.text ?? "";
    const stored = await store.get("1-projects/status.md");
    const storedText = stored ? await stored.text() : "";
    check(
      "a missing opening --- is put back, and the stored note opens with its front matter again",
      !dropped?.isError && storedText.startsWith("---\nupdated: 2026-10-07\nstatus: finished\n"),
    );
    check("the writer is told it was put back", /opening --- line was missing/.test(droppedText));
    check("and the status change it carried reaches the consoles", hints().length === 1);

    await store.put("1-projects/plain.md", "# Plain\n");
    const plainRead = await call("read_note", { path: "1-projects/plain.md" });
    const plainTag = /etag: (\S+)/.exec(plainRead?.content?.[0]?.text ?? "")?.[1];
    await call("write_note", {
      path: "1-projects/plain.md",
      content: "Summary: a heading on purpose\n---\n\nBody.\n",
      ...(plainTag ? { expected_etag: plainTag } : {}),
    });
    const plain = await store.get("1-projects/plain.md");
    check(
      "a note that never had front matter is stored as written, setext heading and all",
      plain !== null && (await plain.text()).startsWith("Summary: a heading on purpose\n---"),
    );

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

    /*
      AND THE SAME QUESTION FOR THE PUBLISHED FOLDER, WHICH IS A DIFFERENT ONE.

      The control plane keeps a route index built from `website/`, and a
      console write marks it stale through `runFileOperation`. This Worker
      writes the same bucket itself, so without a word from here the index goes
      on describing bytes that moved — and the page menu it feeds is handed to
      anyone who asks for any address on that site, including a caller with no
      session asking for a path that does not exist.

      It cannot ride on the tree hint above: that one is gated on changes to
      the tree's *shape*, and the case that matters most here is an edit to a
      page that already exists, which is both an agent rewriting frontmatter
      and a live editing session flushing. It also has to fire on both ends of
      a move, because a page moved out of the folder unpublishes it.

      And it has to fire on nothing else. Hearing it costs a scan that reads
      every published page, so an ordinary note write reporting it would mean a
      full scan after every save.
    */
    const siteCalls = () =>
      controlPlane.calls
        .filter((entry) => entry.path === "/gateway/website")
        .map((entry) => entry.body);

    reset();
    await call("write_note", {
      path: "website/index.md",
      content: "---\ntitle: Home\nnav: 0\n---\n\n# Home\n",
    });
    check(
      "publishing a page says so, with an id and nothing else",
      JSON.stringify(siteCalls()) === JSON.stringify([{ workspaceId: "ws_tree" }]),
    );

    reset();
    const page = await call("read_note", { path: "website/index.md" });
    const pageEtag = /etag: (\S+)/.exec(page?.content?.[0]?.text ?? "")?.[1];
    await call("write_note", {
      path: "website/index.md",
      content: "---\ntitle: Home\nnav: 0\naudience: members\n---\n\n# Home\n",
      ...(pageEtag ? { expected_etag: pageEtag } : {}),
    });
    // Its front matter changed, so since 2026-10-07 the tree hint goes too (see above).
    check("restricting a page that already exists says so", siteCalls().length === 1);

    reset();
    await call("write_note", { path: "2-areas/notes.md", content: "# Notes\n" });
    check("a write outside the folder says nothing about the site", siteCalls().length === 0);

    reset();
    await call("move_note", {
      source: "website/index.md",
      destination: "2-areas/index.md",
    });
    check(
      "moving a page out of the folder says so, judged by the source it left",
      siteCalls().length === 1,
    );

    reset();
    await call("move_note", {
      source: "2-areas/index.md",
      destination: "website/index.md",
    });
    check("moving a page back in says so too", siteCalls().length === 1);
  } finally {
    restore();
  }
}
