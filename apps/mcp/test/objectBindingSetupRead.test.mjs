// Tex's setup read from the pin's own object (`store/objectBinding.js`, `workspaceStore/bindingRows.js`,
// `workspaceStore/setupRules.js`; Dev, 2026-11-04: "can we do setup without convex?"). The setup door used to ask the
// control plane's `/gateway/binding` on every cold text, about 400 ms; the pin's object now answers it in one call,
// with the member rules narrowed to `ai/production` and `ai/agents` exactly as the control plane narrows them.
//
// Sabotage: hand the setup read the full member rules in `bindingRows.js` → "a team note outside the setup folders
// is never visible"; drop the client or pin check in `objectBinding.js` → the ATTACK test fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { bindingRows } from "../src/workspaceStore/bindingRows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { openedFromObject } from "../src/store/objectBinding.js";
import { canSee, PrivacyOverrides } from "../src/privacy/engine.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function namespace() {
  const objects = new Map();
  return {
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { objects: texObjects(sql), rows: workspaceRows(sql), members: workspaceMembers(sql), binding: bindingRows(sql), marks: workspaceMarks(sql) };
        objects.set(id.name, { store, fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

const SECRET = "gateway-secret-for-tests-only-0123456789";
// The pin as a member reads it: the setup folder and a staff folder both `team`, one setup note held private.
const MEMBER_RULES = {
  etag: "m.1",
  accessVersion: 4,
  folders: [
    { prefix: "ai", visibility: "team" },
    { prefix: "staff", visibility: "team" },
  ],
  notes: [
    { path: "ai/production/held.md", visibility: "private" },
    { path: "staff/plan.md", visibility: "team" },
  ],
};
const STAFF = { userId: "user_staff", personalWorkspaceId: "ws_staff", role: "editor", groups: [], at: 1 };

function bindingFor(workspaceId) {
  return {
    binding: { workspaceId, provider: "r2", bucket: `bucket-${workspaceId}`, accessKeyId: `key-${workspaceId}`, secretAccessKey: `secret-${workspaceId}`, capabilities: { conditionalWrite: true }, notesHome: "object", status: "active" },
    searchIndex: null,
    meaningIndex: null,
    encryptionKey: null,
    rotation: null,
    noteCap: null,
    managedEncryption: null,
    privacy: null,
    idLayout: "keys",
    features: { vaultKeyUse: false },
  };
}

async function pin() {
  const workspaceId = "ws_pin";
  const env = { WORKSPACE_STORE: namespace(), GATEWAY_SECRET: SECRET };
  const client = workspaceClient(env, workspaceId);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(MEMBER_RULES, "member");
  const object = env.WORKSPACE_STORE.get(env.WORKSPACE_STORE.idFromName(`workspace:${workspaceId}`));
  object.store.members.put("members", [STAFF]);
  object.store.members.setHome("object");
  const calls = { binding: 0 };
  const controlPlane = { getStorageBinding: async () => ((calls.binding += 1), bindingFor(workspaceId)) };
  // As `session.js` `sessionForSetup` builds it: a person who is no member of the pin, read as a member at `team`.
  const session = { workspaceId, workspaceSlug: "context-lc", actorUserId: "user_not_staff", actorClientId: "context_texts", role: "member", scope: "team", grantedGroups: new Set(), setupRead: true, accessToken: "token" };
  return { env, client, controlPlane, calls, session, workspaceId };
}

async function open(w, session = w.session) {
  const first = await openedFromObject(session, w.env, w.controlPlane);
  if (first.opened !== null) return { source: "object", opened: first.opened, reason: first.reason };
  const opened = await w.controlPlane.getStorageBinding();
  const kept = typeof first.keep === "function" ? await first.keep(opened) : null;
  return { source: "control_plane", opened, reason: first.reason, kept };
}

/** What a read through the opened store judges by: its rules as `store/privacyAuthority.js` hands them to `canSee`. */
function sees(privacy, path) {
  const overrides = new PrivacyOverrides();
  for (const note of privacy.notes) overrides.set(note.path, note.visibility);
  return canSee(path, "team", privacy.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides);
}

test("Tex's setup read opens from the pin's object, for a person who is no member there, with no control-plane call after the first", { skip }, async () => {
  const w = await pin();
  const first = await open(w);
  assert.equal(first.source, "control_plane");
  assert.equal(first.reason, "none_kept");
  assert.deepEqual(first.kept, { kept: true, reason: null }, "the control plane's answer is kept for the next setup read");
  const second = await open(w);
  assert.equal(second.source, "object");
  assert.equal(w.calls.binding, 1);
  assert.deepEqual(second.opened.binding, bindingFor("ws_pin").binding);
  assert.equal(second.opened.privacy.accessVersion, 4);
});

test("a team note outside the setup folders is never visible through it, and the setup is", { skip }, async () => {
  const w = await pin();
  await open(w);
  const { opened } = await open(w);
  const privacy = opened.privacy;
  assert.deepEqual(privacy.folders.map((folder) => folder.prefix), ["ai/production", "ai/agents"]);
  assert.equal(sees(privacy, "ai/production/texting-assistant.md"), true);
  assert.equal(sees(privacy, "ai/agents/helper.md"), true);
  assert.equal(sees(privacy, "ai/production/held.md"), false, "a setup note held private stays held");
  assert.equal(sees(privacy, "staff/plan.md"), false, "a team note elsewhere in the pin");
  assert.equal(sees(privacy, "ai/other.md"), false, "a team note beside the setup folders");
  assert.ok(!JSON.stringify(privacy).includes("staff"), "the member rules for the rest of the pin never leave the object");
});

test("ATTACK: no session but Tex's own setup read of the pin is served this way", { skip }, async () => {
  const w = await pin();
  await open(w);
  const cases = [
    [{ ...w.session, actorClientId: "context_mcp" }, "setup_read_client"],
    [{ ...w.session, workspaceSlug: "someone-else" }, "setup_read_not_pin"],
    [{ ...w.session, scope: "private" }, "setup_read_shape"],
    [{ ...w.session, role: "owner" }, "setup_read_shape"],
    [{ ...w.session, actorUserId: "" }, "no_reader"],
  ];
  for (const [session, reason] of cases) {
    const answer = await openedFromObject(session, w.env, w.controlPlane);
    assert.equal(answer.opened, null);
    assert.equal(answer.reason, reason);
    assert.equal(answer.keep, undefined, `nothing kept for ${reason}`);
  }
  // Switched back, the control plane answers as before.
  assert.equal((await openedFromObject(w.session, { ...w.env, SETUP_FROM_OBJECT: "off" }, w.controlPlane)).reason, "setup_read");
});

test("an object holding no member rules, or not deciding access, answers no setup read", { skip }, async () => {
  const w = await pin();
  await open(w);
  const object = w.env.WORKSPACE_STORE.get(w.env.WORKSPACE_STORE.idFromName("workspace:ws_pin"));
  object.store.members.setHome("convex");
  const answer = await openedFromObject(w.session, w.env, w.controlPlane);
  assert.equal(answer.opened, null);
  assert.equal(answer.reason, "access_not_in_object");
  // And a plain member open still never carries a setup read's answer.
  const raw = await w.client.open("user_not_staff");
  assert.equal(raw.member, false);
  assert.equal(raw.binding, null);
  assert.equal(raw.rules, null);
});
