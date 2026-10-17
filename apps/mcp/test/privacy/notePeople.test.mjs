/**
 * `set_visibility`'s `people` in rows mode (`tools/notePeople.js`): an AI client names who else may open one
 * note, and the gateway hands the control plane `{handle|email, role}` entries to add. The egress gate holds
 * every such call first (`egress.test.mjs`, `agentEgress.test.mjs`); this is what runs after the yes.
 *
 * Sabotage: send a domain to the control plane and "a domain is refused here" fails; map an email to a handle
 * and "handles and emails are sent as such" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withPrivacyAuthority } from "../../src/store/privacyAuthority.js";
import { createPrivacyMethods } from "../../src/controlPlane/privacy.js";
import { loadPrivacyState } from "../../src/privacy/state.js";
import { PRIVACY_KEY, PRIVACY_RULES_BEGIN, PRIVACY_RULES_END } from "../../src/privacy/engine.js";
import { toolSetVisibility } from "../../src/tools/visibility.js";

class MemoryStore {
  constructor() {
    this.objects = new Map();
  }
  seed(key, text) {
    this.objects.set(key, { text, etag: `e-${key}` });
  }
  async get(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag, text: async () => item.text } : null;
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag } : null;
  }
  async list() {
    return { objects: [], truncated: false };
  }
  async put(key, value) {
    this.objects.set(key, { text: String(value), etag: `e-${key}-2` });
    return { etag: `e-${key}-2` };
  }
}

const FILE = [PRIVACY_RULES_BEGIN, "", "```yaml", "default_visibility: private", "folder_defaults:", "  1-projects: team", "```", "", PRIVACY_RULES_END, ""].join("\n");

function world(answer = () => ({ ok: true, version: 8 }), { rows = true } = {}) {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  memory.seed("1-projects/plan.md", "# Plan\n");
  const calls = [];
  const authority = {
    rules: { etag: "r1", folders: [{ prefix: "1-projects", visibility: "team" }], notes: [], ...(rows ? { accessVersion: 7 } : {}) },
    async write() {
      return null;
    },
    async written() {},
    async exported() {},
    async owed() {},
    async setAccess(change) {
      calls.push({ op: "setAccess", ...change });
      return { ok: true, version: 8 };
    },
    async addGrantees(change) {
      calls.push({ op: "addGrantees", ...change });
      return answer(change);
    },
  };
  return { store: withPrivacyAuthority(memory, authority), calls };
}

async function run(store, args) {
  const { rules, overrides } = await loadPrivacyState(store);
  return await toolSetVisibility(store, "private", rules, overrides, args);
}

const text = (result) => result.content[0].text;

test("handles and emails are sent as such, with their roles, and the answer names them", async () => {
  const { store, calls } = world();
  const result = await run(store, {
    path: "1-projects/plan.md",
    people: [{ who: "@ana" }, { who: "Kola@Example.invalid", role: "edit" }],
  });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(calls, [
    {
      op: "addGrantees",
      path: "1-projects/plan.md",
      entries: [
        { handle: "@ana", role: "view" },
        { email: "Kola@Example.invalid", role: "edit" },
      ],
    },
  ]);
  assert.match(text(result), /with: @ana and Kola@Example\.invalid \(who may edit it\)/);
});

test("a domain is refused here, and nothing reaches the control plane", async () => {
  for (const who of ["@acme.example", "acme.example", "*@acme.example"]) {
    const { store, calls } = world();
    const result = await run(store, { path: "1-projects/plan.md", people: [{ who }] });
    assert.equal(result.isError, true);
    assert.match(text(result), /not a whole domain/);
    assert.deepEqual(calls, []);
  }
});

test("a name that is neither a handle nor an address, and an empty list, are refused", async () => {
  const { store, calls } = world();
  assert.match(text(await run(store, { path: "1-projects/plan.md", people: [{ who: "ana" }] })), /neither an @handle nor an email/);
  assert.match(text(await run(store, { path: "1-projects/plan.md", people: [] })), /people is empty/);
  assert.deepEqual(calls, []);
});

test("one name the control plane cannot resolve: nothing changed, and the answer says nothing about which", async () => {
  const { store } = world(() => ({ ok: false, code: "GRANTEE_NOT_FOUND" }));
  const result = await run(store, { path: "1-projects/plan.md", people: [{ who: "@ana" }, { who: "@bo" }] });
  assert.equal(result.isError, true);
  assert.match(text(result), /^nothing changed/);
  assert.doesNotMatch(text(result), /@ana|@bo/);
});

test("an editor is refused as the owner's to do", async () => {
  const { store } = world(() => ({ ok: false, code: "FORBIDDEN" }));
  assert.match(text(await run(store, { path: "1-projects/plan.md", people: [{ who: "@ana" }] })), /only the workspace's owner/);
});

test("a note that is not there is not found, and the control plane is not asked", async () => {
  const { store, calls } = world();
  assert.equal(text(await run(store, { path: "1-projects/missing.md", people: [{ who: "@ana" }] })), "not found");
  assert.deepEqual(calls, []);
});

test("a workspace whose rows are not the truth yet says so", async () => {
  const { store, calls } = world(undefined, { rows: false });
  assert.match(text(await run(store, { path: "1-projects/plan.md", people: [{ who: "@ana" }] })), /not available for this workspace yet/);
  assert.deepEqual(calls, []);
});

test("visibility and people together: the tier first, then the people", async () => {
  const { store, calls } = world();
  const result = await run(store, { path: "1-projects/plan.md", visibility: "private", people: [{ who: "@ana" }] });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(calls.map((call) => call.op), ["setAccess", "addGrantees"]);
  assert.match(text(result), /visibility changed[\s\S]*shared: 1-projects\/plan\.md/);
});

test("the control plane body is the op, the path and the entries", async () => {
  const sent = [];
  const authority = createPrivacyMethods({
    post: async (path, body) => {
      sent.push({ path, body });
      return { ok: true, version: 2 };
    },
  }).privacyAuthority({ accessToken: "token-not-real" }, "ws-test", null);
  await authority.addGrantees({ path: "a.md", entries: [{ email: "x@example.invalid", role: "view" }] });
  assert.deepEqual(sent, [
    {
      path: "/gateway/privacy",
      body: {
        accessToken: "token-not-real",
        expectedWorkspaceId: "ws-test",
        op: "addGrantees",
        path: "a.md",
        entries: [{ email: "x@example.invalid", role: "view" }],
      },
    },
  ]);
});
