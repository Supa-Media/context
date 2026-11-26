// The Mail page's notes through the gateway's front door, from the workspace object (`live/mailNotesRoute.js`,
// `workspaceStore/mailIndex.js`).
//
// 2026-11-25 (owner, approving the boards): "a mail icon underneath the map that opens up in a full page view - and
// it can show special views for mail to bots, mail to areas, and other regular notes". These cases send the request
// the app sends and check the answer is every note with mail the reader may see, newest first, never naming a note
// the reader may not see, and that a note's change is read again.
//
// Sabotage, confirmed (applied, run, named case failing, reverted):
//  1. `canSee` dropped from `handleMailNotes` and `sees` from the index → "a member is never told of a private note's
//     mail" fails.
//  2. The etag check dropped from the index (a summary kept forever) → "a new message is read again" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { bindingRows } from "../src/workspaceStore/bindingRows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { workspaceFacts } from "../src/workspaceStore/facts.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../src/workspaceStore/access.js";
import { sha256Hex } from "../src/controlPlane/index.js";
import { sealBinding } from "../src/workspaceStore/bindingSeal.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
import { MAIL_NOTES_PATH, handleMailNotes } from "../src/live/mailNotesRoute.js";
import { PRE_PARSED_RULES, PrivacyOverrides } from "../src/privacy/engine.js";
import { mailSummaryOf, LAST_TEXT } from "../src/workspaceStore/mailIndex.js";
import { createWorkerCtx } from "./workerCtx.mjs";

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

/** Workspace objects by name, each answering as the real object's `serveWorkspaceStore` does, writes included. */
function namespace() {
  const objects = new Map();
  const ops = [];
  return {
    ops,
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const bodies = texObjects(sql);
        const store = {
          sql,
          objects: bodies,
          facts: workspaceFacts(sql, bodies),
          rows: workspaceRows(sql),
          person: personRows(sql),
          members: workspaceMembers(sql),
          binding: bindingRows(sql),
          marks: workspaceMarks(sql),
          mirror: mirrorOutbox(sql),
          transact: (fn) => fn(),
          flushMirror: async () => ({ done: true }),
          mirrorSoon: async () => {},
        };
        objects.set(id.name, {
          store,
          fetch: (request) => {
            ops.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "{}")).op);
            return serveWorkspaceStore(store, request);
          },
        });
      }
      return objects.get(id.name);
    },
  };
}

const SECRET = "gateway-secret-for-tests-only-0123456789";
const RULES = {
  etag: "m.1",
  accessVersion: 1,
  folders: [{ prefix: "areas", visibility: "team" }, { prefix: "bots", visibility: "team" }, { prefix: "products", visibility: "team" }],
  notes: [{ path: "areas/secret.md", visibility: "private" }],
};

function answerFor(workspaceId, notesHome) {
  return {
    binding: { workspaceId, provider: "r2", endpoint: "https://s3.example-folders.test", bucket: `bucket-${workspaceId}`, accessKeyId: `key-${workspaceId}`, secretAccessKey: `secret-${workspaceId}`, capabilities: { conditionalWrite: true, conditionalCreate: true }, notesHome, notesBackfilledAt: 1, status: "active" },
    searchIndex: null,
    meaningIndex: null,
    encryptionKey: null,
    rotation: null,
    noteCap: null,
    managedEncryption: null,
    privacy: RULES,
    idLayout: "keys",
    features: {},
    keyed: true,
  };
}

const id = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** One person's own workspace on its object: their session, access, sealed binding and notes, all there. */
async function workspace(ns, env, { pwid, user, slug, notes, notesHome = "object" }) {
  const token = objectToken("access", pwid, "a".repeat(43));
  const access = workspaceClient(env, pwid).access;
  await access.pin(user);
  await access.reach.put([{ workspaceId: pwid, slug, kind: "personal", role: "owner", groups: [], at: 1 }]);
  await access.connections.put([
    { grantId: `g-${pwid}`, clientId: "context-console", clientName: "Context", workspaceId: pwid, scopes: ["context:read", "context:write", "context:private"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
  ]);
  await access.setHome(ACCESS_HOMES.OBJECT);
  const client = workspaceClient(env, pwid);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(RULES, "member");
  const object = ns.get(ns.idFromName(`workspace:${pwid}`));
  object.store.rows.pinWorkspace(pwid);
  const rows = ["areas", "areas/finance", "areas/finance/mail", "bots", "bots/grok-bot", "bots/grok-bot/mail", "products"].map((path) => ({ id: `d-${path}-${pwid}`, path, kind: "folder", at: 1 }));
  let n = 0;
  for (const [path, text] of Object.entries(notes)) {
    n += 1;
    const noteId = id(n + (slug === "alice" ? 0 : 100));
    rows.push({ id: `f-${pwid}-${n}`, path, kind: "file", at: n + 1, storageKey: `notes/${noteId}.md`, noteId, etag: `e-${pwid}-${n}` });
    await object.store.objects.put(`notes/${noteId}.md`, text);
  }
  object.store.rows.put(rows);
  object.store.rows.putRules(RULES);
  object.store.members.put("members", [{ userId: user, personalWorkspaceId: pwid, role: "owner", groups: [], at: 1 }]);
  object.store.members.setHome("object");
  object.store.rows.markBackfilled(1);
  object.store.binding.put({ sealed: await sealBinding(answerFor(pwid, notesHome), { secret: SECRET, workspaceId: pwid }), at: Date.now(), epoch: object.store.binding.get().epoch });
  return { token, object, pwid, user, slug };
}

const mailBlock = (...lines) => `\n\n\`\`\`mail\n${lines.join("\n")}\n\`\`\`\n`;
const ALICE_NOTES = {
  "areas/finance/about.md": "---\nowner: Finance\n---\n# Finance\n",
  "areas/finance/mail/seyi.md": `# Mail with Finance${mailBlock("- 2026-11-25T20:00:00.000Z @seyi to everyone: How much this month?", "- 2026-11-25T20:01:00.000Z finance (Grok) to everyone [used 2%]: $512 so far.")}`,
  "bots/grok-bot/mail/seyi.md": `# Mail with Grok Bot${mailBlock("- 2026-11-25T19:10:00.000Z @seyi to everyone: Please check your card.")}`,
  "products/plan.md": `# Plan\n\nThe plan.${mailBlock("- 2026-11-25T18:00:00.000Z builder (Claude) joined", "- 2026-11-25T18:02:00.000Z builder (Claude) to reviewer: Can you check the cold path?")}`,
  "areas/secret.md": `# Secret${mailBlock("- 2026-11-25T21:00:00.000Z @seyi to everyone: Only owners.")}`,
  "todo.md": "# Todo\n\nNo mail here, though it says ```mail once in passing.\n",
};

async function world() {
  const ns = namespace();
  const env = { WORKSPACE_STORE: ns, GATEWAY_SECRET: SECRET, CONTROL_PLANE_URL: "https://control.invalid", CONTROL_PLANE_SECRET: "x".repeat(40) };
  const alice = await workspace(ns, env, { pwid: "pAlice", user: "uAlice", slug: "alice", notes: ALICE_NOTES });
  return { ns, env, alice };
}

const ask = async (w, who, body, prefix = `/@${who.slug}`) => {
  const response = await worker.fetch(
    new Request(`https://gateway.test${prefix}${MAIL_NOTES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    w.env,
    createWorkerCtx(),
  );
  return { status: response.status, body: await response.json() };
};

const paths = (answer) => answer.notes.map((note) => note.path);

test("the route's address is never read as a workspace name", () => {
  assert.deepEqual(splitWorkspacePath(MAIL_NOTES_PATH), { slug: null, path: MAIL_NOTES_PATH });
});

test("a note's mail is summed up: how many, who joined, and the newest, cut short", () => {
  assert.equal(mailSummaryOf("# Plain\n"), null);
  assert.equal(mailSummaryOf("Says ```mail but has no block.\n"), null);
  const summary = mailSummaryOf(ALICE_NOTES["products/plan.md"]);
  assert.deepEqual(summary, { count: 1, joined: ["builder"], last: { at: "2026-11-25T18:02:00.000Z", from: "builder", to: "reviewer", used: null, text: "Can you check the cold path?" } });
  const long = mailSummaryOf(`# Long${mailBlock(`- 2026-11-25T18:02:00.000Z builder to everyone: ${"x".repeat(1000)}`)}`);
  assert.equal(long.last.text.length, LAST_TEXT);
});

test("every note with mail comes back, newest message first, from the object", { skip }, async () => {
  const w = await world();
  w.ns.ops.length = 0;
  const { status, body } = await ask(w, w.alice, {});
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.kind, "mailNotes");
  assert.equal(body.complete, true);
  assert.deepEqual(paths(body), ["areas/secret.md", "areas/finance/mail/seyi.md", "bots/grok-bot/mail/seyi.md", "products/plan.md"]);
  const finance = body.notes.find((note) => note.path === "areas/finance/mail/seyi.md");
  assert.deepEqual(finance, { path: "areas/finance/mail/seyi.md", count: 2, joined: ["@seyi", "finance"], last: { at: "2026-11-25T20:01:00.000Z", from: "finance", to: "everyone", used: 2, text: "$512 so far." } });
  assert.ok(w.ns.ops.includes("ws.facts"), w.ns.ops.join(", "));
});

test("a new message is read again, and a note whose mail is gone drops out", { skip }, async () => {
  const w = await world();
  await ask(w, w.alice, {});
  await w.alice.object.store.objects.put(`notes/${id(4)}.md`, `# Plan${mailBlock("- 2026-11-25T22:00:00.000Z reviewer to builder: Cold path ok.")}`);
  await w.alice.object.store.objects.put(`notes/${id(3)}.md`, "# Mail with Grok Bot\n");
  const { body } = await ask(w, w.alice, {});
  assert.deepEqual(paths(body), ["products/plan.md", "areas/secret.md", "areas/finance/mail/seyi.md"]);
  assert.equal(body.notes[0].last.text, "Cold path ok.");
});

test("a member is never told of a private note's mail", { skip }, async () => {
  const w = await world();
  w.alice.object.store.members.put("members", [{ userId: w.alice.user, personalWorkspaceId: w.alice.pwid, role: "member", groups: [], at: 1 }]);
  await workspaceClient(w.env, w.alice.pwid).access.reach.put([{ workspaceId: w.alice.pwid, slug: "alice", kind: "personal", role: "member", groups: [], at: 1 }]);
  const { status, body } = await ask(w, w.alice, {});
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(!JSON.stringify(body).includes("secret") && !JSON.stringify(body).includes("Only owners"), JSON.stringify(body));
  assert.ok(paths(body).includes("products/plan.md"));
});

test("one person's token never reads another person's mail", { skip }, async () => {
  const w = await world();
  const bob = await workspace(w.ns, w.env, { pwid: "pBob", user: "uBob", slug: "bob", notes: { "products/bobs.md": `# Bob${mailBlock("- 2026-11-25T18:00:00.000Z bob to everyone: hi")}` } });
  for (const prefix of ["/@alice", ""]) {
    const { status, body } = await ask(w, bob, {}, prefix);
    const text = JSON.stringify(body);
    for (const path of Object.keys(ALICE_NOTES)) assert.ok(!text.includes(path), `${prefix}: ${path} named to Bob: ${status} ${text}`);
  }
});

/** The handler alone, over a store whose object answers `mail` for the mail ask. */
function handlerStore(mail, { home = "object", rules = [{ prefix: "areas", vis: "team" }] } = {}) {
  const asked = [];
  const client = {
    facts: async (fields) => {
      asked.push(fields.ask);
      return { served: true, mail, complete: true, more: false };
    },
  };
  return {
    asked,
    store: {
      objectReading: { client, home, behind: false, scope: "team", names: [], workspaceId: "w1" },
      get: async (key) => (key === "privacy.md" ? { [PRE_PARSED_RULES]: { rules, overrides: new PrivacyOverrides() } } : null),
    },
  };
}

const request = (body) => new Request(`https://gateway.test${MAIL_NOTES_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const TEAM = { scope: "team", scopes: ["context:read"], grantedGroups: new Set() };
const row = (path) => ({ path, count: 1, joined: ["a"], last: { at: "2026-11-25T18:00:00.000Z", from: "a", to: "everyone", used: null, text: "hi" } });

test("the gateway judges the reader itself: a note its rules hold back is never answered", async () => {
  const { store } = handlerStore([row("areas/a.md"), row("private/b.md")]);
  const response = await handleMailNotes(request({}), store, TEAM);
  assert.equal(response.status, 200);
  assert.deepEqual(paths(await response.json()), ["areas/a.md"]);
});

test("a workspace whose notes are not in its object yet is handed back, its object never asked", async () => {
  for (const home of ["bucket", "dual", null]) {
    const { store, asked } = handlerStore([row("areas/a.md")], { home });
    const response = await handleMailNotes(request({}), store, TEAM);
    assert.deepEqual([response.status, await response.json()], [409, { error: "not_object" }], String(home));
    assert.deepEqual(asked, [], String(home));
  }
  const behind = handlerStore([]);
  behind.store.objectReading.behind = true;
  assert.equal((await handleMailNotes(request({}), behind.store, TEAM)).status, 409);
});

test("a session without read access is refused before anything is asked", async () => {
  const { store, asked } = handlerStore([row("areas/a.md")]);
  const response = await handleMailNotes(request({}), store, { ...TEAM, scopes: [] });
  assert.equal(response.status, 403);
  assert.deepEqual(asked, []);
});

test("a request that is not one is refused", { skip }, async () => {
  const w = await world();
  const answer = await ask(w, w.alice, { folder: "areas" });
  assert.equal(answer.status, 400);
});
