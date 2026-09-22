import worker from "../src/index.js";
import { moveDocument } from "@context/collaboration";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "./controlPlaneStub.mjs";

const encoder = new TextEncoder();

function bucket() {
  const objects = new Map();
  let sequence = 0;
  return {
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        etag: value.etag,
        text: async () => value.text,
        arrayBuffer: async () => encoder.encode(value.text).buffer,
      };
    },
    async put(key, value, options = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.absent === true && current) return null;
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      const etag = `e${++sequence}`;
      objects.set(key, { etag, text });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects]
          .filter(([key]) => !prefix || key.startsWith(prefix))
          .map(([key, value]) => ({ key, size: value.text.length, etag: value.etag })),
        truncated: false,
      };
    },
  };
}

const privacy = `---\nrole: privacy-manifest\nversion: 1\n---\n\n# Brain Privacy Map\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n\`\`\`yaml\ndefault_visibility: private\nfolder_defaults:\n  team: team\nnote_overrides:\n  group/note.md: @editors\n  group/moved.md: @editors\n\`\`\`\n\n<!-- END BRAIN PRIVACY RULES -->\n`;

async function request(env, token, body) {
  return worker.fetch(
    new Request("https://gateway.test/collaboration", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {} },
  );
}

async function callTool(env, token, name, args) {
  const response = await worker.fetch(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    { waitUntil() {} },
  );
  const body = await response.json();
  return body.result ?? body.error;
}

/** Adversarial HTTP checks for the collaboration auth and route boundary. */
export async function runCollaborationChecks(check) {
  const primary = bucket();
  const other = bucket();
  const unsupported = bucket();
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  const ownerToken = "cat_collaboration_owner_0000000000000000";
  const readerToken = "cat_collaboration_reader_0000000000000000";
  const otherToken = "cat_collaboration_other_0000000000000000";
  const revokedToken = "cat_collaboration_revoked_0000000000000000";
  const groupToken = "cat_collaboration_group_000000000000000000";
  const ordinaryGroupToken = "cat_collaboration_oauth_group_00000000000";
  try {
    controlPlane.addWorkspace("ws_collaboration", "collab", {
      provider: "r2-binding",
      bindingName: "COLLAB_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    controlPlane.addWorkspace("ws_other", "other", {
      provider: "r2-binding",
      bindingName: "OTHER_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    controlPlane.addWorkspace("ws_unsupported", "unsupported", {
      provider: "r2-binding",
      bindingName: "UNSUPPORTED_BUCKET",
      capabilities: { conditionalWrite: false, conditionalCreate: false, conditionalDelete: false },
      status: "active",
    });
    await primary.put("privacy.md", privacy);
    await primary.put("team/open.md", "# visible");
    await primary.put("secret.md", "# private");
    await primary.put("group/note.md", "# group visible");
    await other.put("team/open.md", "# other workspace");
    await unsupported.put("team/open.md", "# unsupported");

    await controlPlane.addGrant({
      accessToken: ownerToken,
      workspaceId: "ws_collaboration",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "collaboration-owner",
      userId: "owner",
    });
    await controlPlane.addGrant({
      accessToken: readerToken,
      workspaceId: "ws_collaboration",
      role: "editor",
      scopes: ["context:read"],
      clientId: "collaboration-reader",
      userId: "reader",
    });
    await controlPlane.addGrant({
      accessToken: otherToken,
      workspaceId: "ws_other",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "other-owner",
      userId: "other",
    });
    const revokedGrant = await controlPlane.addGrant({
      accessToken: revokedToken,
      workspaceId: "ws_collaboration",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "revoked-owner",
      userId: "revoked",
    });
    controlPlane.revoke(revokedGrant);
    const liveConsoleNames = { ws_collaboration: ["editors"] };
    await controlPlane.addGrant({
      accessToken: groupToken,
      workspaceId: "ws_collaboration",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "context_console",
      userId: "group-editor",
      grantedNamesByWorkspace: liveConsoleNames,
    });
    await controlPlane.addGrant({
      accessToken: ordinaryGroupToken,
      workspaceId: "ws_collaboration",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "ordinary-oauth-client",
      userId: "ordinary-editor",
      grantedNamesByWorkspace: { ws_collaboration: ["editors"] },
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "COLLAB_BUCKET,OTHER_BUCKET,UNSUPPORTED_BUCKET",
      COLLAB_BUCKET: primary,
      OTHER_BUCKET: other,
      UNSUPPORTED_BUCKET: unsupported,
    };
    const read = await request(env, ownerToken, { path: "team/open.md" });
    const readBody = await read.json();
    check("collaboration reader receives the engine snapshot", read.status === 200 &&
      readBody.text === "# visible" && typeof readBody.documentId === "string" &&
      typeof readBody.update === "string" && typeof readBody.etag === "string");

    const groupRead = await request(env, groupToken, { path: "group/note.md" });
    const groupBody = await groupRead.json();
    const groupWrite = await request(env, groupToken, {
      path: "group/note.md",
      replacement: { expectedEtag: groupBody.etag, text: "# group edited\n" },
    });
    check("a console group grant reads and updates its named collaboration note",
      groupRead.status === 200 && groupBody.text === "# group visible" && groupWrite.status === 200 &&
      (await groupWrite.json()).text === "# group edited\n");

    await moveDocument(primary, "group/note.md", "group/moved.md");
    const groupMoved = await request(env, groupToken, { path: "group/note.md" });
    check("a moved group note reauthorizes its destination before returning content",
      groupMoved.status === 200 && (await groupMoved.json()).text === "# group edited\n");

    liveConsoleNames.ws_collaboration = [];
    const removedGroup = await request(env, groupToken, { path: "group/note.md" });
    check("removing live group membership closes collaboration on the next request",
      removedGroup.status === 404 &&
      JSON.stringify(await removedGroup.json()) === JSON.stringify({ error: "not_found" }));

    const ordinaryGroup = await request(env, ordinaryGroupToken, { path: "group/note.md" });
    check("an ordinary OAuth grant cannot claim console group authority",
      ordinaryGroup.status === 404 &&
      JSON.stringify(await ordinaryGroup.json()) === JSON.stringify({ error: "not_found" }));

    const human = await request(env, ownerToken, {
      path: "team/open.md",
      replacement: { expectedEtag: readBody.etag, text: "# visible\nHuman edit\n" },
    });
    const humanBody = await human.json();
    const agent = await request(env, ownerToken, {
      path: "team/open.md",
      replacement: { expectedEtag: readBody.etag, text: "# visible\nAgent edit\n" },
    });
    const agentBody = await agent.json();
    check("legacy replacement keeps a human edit when an agent saves from the retained base",
      human.status === 200 && agent.status === 200 &&
      typeof agentBody.text === "string" && agentBody.text.includes("Human edit") &&
      agentBody.text.includes("Agent edit"));

    const auditRows = [...primary.objects]
      .filter(([key]) => key.startsWith(".context/audit/"))
      .map(([, value]) => JSON.parse(value.text));
    const ownerAuditRows = auditRows.filter((row) => row.actor_user_id === "owner");
    check("accepted collaboration changes write actor-bound audit rows",
      ownerAuditRows.length === 2 && ownerAuditRows.every((row) =>
        row.action === "update_note" && row.actor_user_id === "owner" &&
        row.actor_client_id === "collaboration-owner" && row.workspace_id === "ws_collaboration"));
    check("collaboration audit rows carry metadata and no note content",
      auditRows.every((row) => !JSON.stringify(row).includes("Human edit") &&
        !JSON.stringify(row).includes("Agent edit") && typeof row.details?.content_bytes === "number"));

    const auditCountBeforeNoop = auditRows.length;
    const noop = await request(env, ownerToken, {
      path: "team/open.md",
      replacement: { expectedEtag: agentBody.etag, text: agentBody.text },
    });
    check("an unchanged collaboration retry succeeds without inventing an audit change",
      noop.status === 200 && [...primary.objects.keys()].filter((key) => key.startsWith(".context/audit/")).length === auditCountBeforeNoop);

    await moveDocument(primary, "team/open.md", "team/renamed.md");
    const movedOwner = await request(env, ownerToken, { path: "team/open.md" });
    const movedOwnerBody = await movedOwner.json();
    check("an authorized collaboration client follows a moved head",
      movedOwner.status === 200 && movedOwnerBody.text.includes("Human edit") &&
      movedOwnerBody.documentId === readBody.documentId);

    await primary.put("team/batch.md", "# batch\n");
    const batchBase = await (await request(env, ownerToken, { path: "team/batch.md" })).json();
    const batchMove = await callTool(env, ownerToken, "move_notes", {
      moves: [{
        source: "team/batch.md",
        destination: "team/batch-moved.md",
        expected_source_etag: batchBase.etag,
      }],
    });
    const batchDestination = await (await request(env, ownerToken, {
      path: "team/batch-moved.md",
    })).json();
    check("move_notes carries an active collaboration identity to its destination",
      !batchMove?.isError && batchDestination.documentId === batchBase.documentId);
    await primary.put("team/batch.md", "# recreated batch source\n");
    const batchRecreated = await (await request(env, ownerToken, { path: "team/batch.md" })).json();
    check("move_notes leaves a moved head that fences the old generation",
      batchRecreated.documentId !== batchBase.documentId &&
      batchRecreated.text === "# recreated batch source\n");

    await primary.put("team/folder/source.md", "# folder source\n");
    const folderBase = await (await request(env, ownerToken, {
      path: "team/folder/source.md",
    })).json();
    const folderMove = await callTool(env, ownerToken, "move_folder", {
      source: "team/folder",
      destination: "team/folder-moved",
    });
    const folderDestination = await (await request(env, ownerToken, {
      path: "team/folder-moved/source.md",
    })).json();
    check("move_folder carries active collaboration identities to their destinations",
      !folderMove?.isError && folderDestination.documentId === folderBase.documentId);
    await primary.put("team/folder/source.md", "# recreated folder source\n");
    const folderRecreated = await (await request(env, ownerToken, {
      path: "team/folder/source.md",
    })).json();
    check("move_folder leaves moved heads that fence old generations",
      folderRecreated.documentId !== folderBase.documentId);

    await primary.put("team/private-source.md", "# private destination");
    const privateSourceRead = await request(env, ownerToken, { path: "team/private-source.md" });
    const privateSourceBody = await privateSourceRead.json();
    await moveDocument(primary, "team/private-source.md", "private-destination.md", {
      expectedEtag: privateSourceBody.etag,
    });
    const hiddenMoved = await request(env, readerToken, { path: "team/private-source.md" });
    check("a moved head is not a path oracle for a hidden destination", hiddenMoved.status === 404 &&
      JSON.stringify(await hiddenMoved.json()) === JSON.stringify({ error: "not_found" }));

    const hidden = await request(env, readerToken, { path: "secret.md" });
    check("a reader cannot use collaboration to discover a hidden note", hidden.status === 404 &&
      JSON.stringify(await hidden.json()) === JSON.stringify({ error: "not_found" }));

    const revoked = await request(env, revokedToken, { path: "team/open.md" });
    check("a revoked collaboration grant is rejected before storage", revoked.status === 401);

    const crossWorkspace = await request(env, ownerToken, { path: "team/open.md", workspaceId: "ws_other" });
    check("client workspace identities are rejected rather than trusted", crossWorkspace.status === 400);

    const forgedActor = await request(env, ownerToken, { path: "team/open.md", actor: "owner" });
    check("forged caller identities are rejected by the closed request schema", forgedActor.status === 400);

    const malformed = await request(env, ownerToken, {
      path: "team/open.md",
      documentId: readBody.documentId,
      update: "%%%",
    });
    check("malformed collaboration updates are refused", malformed.status === 400 &&
      JSON.stringify(await malformed.json()) === JSON.stringify({ error: "invalid_update" }));

    const readOnlyUpdate = await request(env, readerToken, {
      path: "team/open.md",
      documentId: readBody.documentId,
      update: readBody.update,
    });
    check("read scope never becomes write authority", readOnlyUpdate.status === 403);

    const readOnlyReplacement = await request(env, readerToken, {
      path: "team/open.md",
      replacement: { expectedEtag: readBody.etag, text: "private" },
    });
    check("read scope never becomes replacement authority", readOnlyReplacement.status === 403);

    const unsupportedResult = await request(
      env,
      otherToken,
      { path: "team/open.md" },
    );
    check("a separate workspace reaches only its own bucket", unsupportedResult.status === 200 &&
      (await unsupportedResult.json()).text === "# other workspace");

    const unsupportedToken = "cat_collaboration_unsupported_000000000000";
    await controlPlane.addGrant({
      accessToken: unsupportedToken,
      workspaceId: "ws_unsupported",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "unsupported-owner",
      userId: "unsupported",
    });
    const unsupportedResponse = await request(env, unsupportedToken, { path: "team/open.md" });
    check("storage without proven CAS fails closed", unsupportedResponse.status === 501);
  } finally {
    restore();
  }
}
