/**
 * `set_visibility`'s `people` through the control plane stub (`controlPlaneStub/tree.mjs`), reached the way a bench
 * world reaches it: the gateway's control-plane client posts `addGrantees` to the stub's `/gateway/privacy`, which
 * answers as `addGranteesOp` does in production (owner only; `{handle|email, role}` entries are added to the row's
 * list; a name nobody holds is `GRANTEE_NOT_FOUND` with nothing written; the answer is `{ok, version}`).
 *
 * Sabotage: take the `addGrantees` branch out of the stub's `privacy()` (it answers NOT_SUPPORTED again) and the
 * first test fails with "the people could not be added right now".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTreeRoutes } from "../controlPlaneStub/tree.mjs";
import { createPrivacyMethods } from "../../src/controlPlane/privacy.js";
import { withPrivacyAuthority } from "../../src/store/privacyAuthority.js";
import { loadPrivacyState } from "../../src/privacy/state.js";
import { PRIVACY_KEY, PRIVACY_RULES_BEGIN, PRIVACY_RULES_END } from "../../src/privacy/engine.js";
import { toolSetVisibility } from "../../src/tools/visibility.js";

const WS = "ws_people_stub";
const PATH = "1-projects/plan.md";

const FILE = [PRIVACY_RULES_BEGIN, "", "```yaml", "default_visibility: private", "folder_defaults:", "  1-projects: team", "```", "", PRIVACY_RULES_END, ""].join("\n");

const RULES = { etag: "rules-1", folders: [{ prefix: "1-projects", visibility: "team" }], notes: [], accessVersion: 1 };

const GRANTS = {
  owner_token: { workspaceId: WS, role: "owner", scopes: ["context:read", "context:write"], userId: "user_owner" },
  editor_token: { workspaceId: WS, role: "editor", scopes: ["context:read", "context:write"], userId: "user_editor" },
};

async function grantForAccessToken(token) {
  return GRANTS[token] ?? null;
}

/** A bucket the tree is copied from, and the store the tools read through. */
class Bucket {
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
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: this.objects.get(key).etag, size: 1 }));
    return { objects, truncated: false };
  }
  async put(key, value) {
    this.seed(key, String(value));
    return { etag: `e-${key}` };
  }
}

/** The gateway's authority for `token`, with the stub's `/gateway/privacy` answering its posts. */
function world(token) {
  const bucket = new Bucket();
  bucket.seed(PRIVACY_KEY, FILE);
  bucket.seed(PATH, "# Plan\n");
  const routes = createTreeRoutes(grantForAccessToken, new Map());
  routes.serveTree(WS, bucket);
  routes.knownHandles.set("@ana", { kind: "user", id: "user_ana" });
  const post = async (path, body) => routes.handle(path, body);
  const authority = createPrivacyMethods({ post }).privacyAuthority({ accessToken: token }, WS, RULES);
  return { routes, store: withPrivacyAuthority(bucket, authority) };
}

async function setVisibility(store, args) {
  const { rules, overrides } = await loadPrivacyState(store);
  return await toolSetVisibility(store, "private", rules, overrides, args);
}

const text = (result) => result.content[0].text;

test("an owner's set_visibility with people succeeds through the stub, and the stub holds the people", async () => {
  const { routes, store } = world("owner_token");
  const result = await setVisibility(store, {
    path: PATH,
    people: [{ who: "@ana" }, { who: "Kola@Example.invalid", role: "edit" }],
  });
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /^shared: 1-projects\/plan\.md/);
  assert.deepEqual(routes.granteesOf(WS, PATH), [
    { kind: "user", id: "user_ana", role: "view" },
    { kind: "email", id: "kola@example.invalid", role: "edit" },
  ]);
});

test("a name nobody holds: nothing changed, the answer names no one, and nothing is held", async () => {
  const { routes, store } = world("owner_token");
  const result = await setVisibility(store, { path: PATH, people: [{ who: "@nobody" }] });
  assert.equal(result.isError, true);
  assert.match(text(result), /^nothing changed/);
  assert.doesNotMatch(text(result), /nobody/);
  assert.deepEqual(routes.granteesOf(WS, PATH), []);
});

test("an editor is refused as production refuses one: FORBIDDEN, and nothing is held", async () => {
  const { routes, store } = world("editor_token");
  const result = await setVisibility(store, { path: PATH, people: [{ who: "@ana" }] });
  assert.equal(result.isError, true);
  assert.match(text(result), /only the workspace's owner/);
  assert.deepEqual(routes.granteesOf(WS, PATH), []);
});

test("a note the tree does not hold is NOT_FOUND, as a path with no row is in production", async () => {
  const { store } = world("owner_token");
  const result = await setVisibility(store, { path: "1-projects/missing.md", people: [{ who: "@ana" }] });
  assert.equal(result.isError, true);
  assert.match(text(result), /not found/);
});
