/**
 * EVERY TEX TURN RUNS ON ITS SETUP, WHOEVER THE PERSON IS.
 *
 * Tex's setup is `ai/production/texting-assistant.md` (and its skills and job setups) in the pinned workspace, a
 * staff-only `team` note. It was read through the person's own reach there, so a person who is not a member of the
 * pin (a pin reader, read as a guest) and every group chat whose setup row is read as the chat (#2498) read nothing,
 * and Tex ran on its built-in words without saying so: no open web, five pages a turn, none of the setup's rules
 * (2026-10-23 to 26, and 2026-10-31 to 2026-11-02, found from Dev2's maritime.sh job). Every fixture in
 * `agentProduction.test.mjs` made its people members of the pin, which is why that suite stayed green.
 *
 * So here nobody is a member: the pin's rules for the person and for the chat hold `ai/` private, exactly as a
 * guest's and a chat's rendering do in production. Only Tex's own setup read (`session.js` `sessionForSetup`,
 * `setupRead` on `/gateway/binding`, `apps/convex/functions/lib/texSetupRead.ts`) sees the note.
 *
 * Sabotage record (local edits, reverted):
 * 1. `readInPin` (production.js) skips the door: the 1:1 and group turns fail (the built-in words).
 * 2. `sessionStore.js` stops sending `setupRead`: the same two fail (the person's rules hold ai/ private).
 * 3. `sessionForSetup` answers for any client: "the setup door is Tex's alone" fails.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { PRODUCTION_TEXTING_PATH } from "../src/agent/production.js";
import { resolveSession, sessionForSetup, TEX_SETUP_CLIENTS } from "../src/session.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { BUILTIN_ALLOWED, systemText } from "./agentModelFixture.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-setup-door.test";
const TOKEN_GUEST = `cat_door_guest_${"0".repeat(24)}`;
const TOKEN_GROUP = `cat_door_group_${"0".repeat(24)}`;
const TOKEN_APP = `cat_door_appcl_${"0".repeat(24)}`;
const PROMPT = "SETUP-DOOR-MARK: You are Tex. Open any page you need.";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\nopen_web: yes\n---\n\n" + `${PROMPT}\n`;
const MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  notes: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";

/** The pin as a guest and as a chat read it: the staff folder `ai/` is private to them. */
const PERSON_RULES = { etag: "rules-person-1", accessVersion: 1, folders: [{ prefix: "ai", visibility: "private" }, { prefix: "guides", visibility: "team" }], notes: [] };
/** What the control plane's setup read hands Tex: a member's rules, narrowed to the setup's folders (`texSetupRead.ts`). */
const SETUP_RULES = { etag: "rules-setup-1", accessVersion: 1, folders: [{ prefix: "ai/production", visibility: "team" }, { prefix: "ai/agents", visibility: "team" }], notes: [] };

function binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  };
}

const gatewayCalls = [];
const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  TEX_STORE: texStoreNamespace().namespace,
  GATEWAY_SECRET,
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: "gateway-token-fixture-0000000000",
};
const controlPlane = createControlPlaneStub();
const restore = [];
let pinnedBucket;

async function ask(token, extra = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What are you?", ...extra }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text };
}

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());
  controlPlane.serveTreesFrom(null, { s3 });
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      gatewayCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  controlPlane.addWorkspace("ws_door_mine", "door-mine", binding("door-mine", "AA"));
  controlPlane.addWorkspace("ws_door_pin", "context-lc", binding("door-pin", "BB"), { kind: "shared" });
  controlPlane.setBuiltinVerdict("ws_door_mine", BUILTIN_ALLOWED);
  s3.bucketFor("door-mine").set("privacy.md", { body: MANIFEST, etag: "p0" });
  pinnedBucket = s3.bucketFor("door-pin");
  controlPlane.holdRules("ws_door_pin", PERSON_RULES);
  controlPlane.holdSetupRules("ws_door_pin", SETUP_RULES);

  const scopes = ["context:read", "context:write", "context:private"];
  // A person texting Tex who is not a member of the pin: they reach it as a pin reader, read as a guest.
  await controlPlane.addGrant({
    workspaceId: "ws_door_mine", role: "owner", userId: "user_door_guest", accessToken: TOKEN_GUEST, scopes, clientId: "context_texts",
    alsoMemberOf: [{ workspaceId: "ws_door_pin", role: "member", grantedNames: ["#reads-as-guest"] }],
  });
  // A group chat with a home in the pin: its setup row is read as the chat (`liveGrants.ts` `groupSetupRow`).
  await controlPlane.addGrant({
    workspaceId: "ws_door_mine", role: "editor", userId: "user_door_guest", accessToken: TOKEN_GROUP,
    scopes: ["context:read", "context:write"], clientId: "context_texts_group",
    alsoMemberOf: [{ workspaceId: "ws_door_pin", role: "editor", setupOnly: true, grantedNames: ["#reads-as-guest", "#reads-as-chat", "#k7m2p9q4x1v8"] }],
  });
  // An AI client of the same person: never Tex, so never a setup read.
  await controlPlane.addGrant({
    workspaceId: "ws_door_mine", role: "owner", userId: "user_door_guest", accessToken: TOKEN_APP, scopes, clientId: "mcp_client_door_app",
    alsoMemberOf: [{ workspaceId: "ws_door_pin", role: "member", grantedNames: ["#reads-as-guest"] }],
  });
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  gatewayCalls.length = 0;
  controlPlane.setupReads.length = 0;
  pinnedBucket.set("privacy.md", { body: MANIFEST, etag: "p1" });
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: SETUP, etag: "s0" });
});

test("a person who is not a member of the pin still gets Tex's setup on a 1:1 text", async () => {
  const response = await ask(TOKEN_GUEST);
  assert.equal(response.status, 200, response.text);
  const system = systemText(gatewayCalls.at(-1)?.body);
  assert.equal(system.split(PROMPT).length, 2, "the production prompt, exactly once, not the built-in words");
  assert.ok(controlPlane.setupReads.some((read) => read.clientId === "context_texts" && read.workspaceId === "ws_door_pin"), "read as Tex's setup read");
});

test("a group chat whose pin row is read as the chat still gets Tex's setup", async () => {
  const response = await ask(TOKEN_GROUP, { group: { key: "a".repeat(64), members: "b".repeat(64), from: "ada" } });
  assert.equal(response.status, 200, response.text);
  const system = systemText(gatewayCalls.at(-1)?.body);
  assert.equal(system.split(PROMPT).length, 2, "the production prompt, exactly once");
  assert.ok(controlPlane.setupReads.some((read) => read.clientId === "context_texts_group"));
});

test("an AI client's own turn never asks for a setup read", async () => {
  await ask(TOKEN_APP);
  assert.deepEqual(controlPlane.setupReads, []);
});

test("the setup door is Tex's alone, read-only, with no names, and opens no further door", async () => {
  const stub = {
    async resolveSession() {
      return {
        grantId: "grant_door", clientId: "context_texts", actorUserId: "user_door", scopes: ["context:read", "context:write"], defaultWorkspaceId: "ws_mine",
        workspaces: [
          { workspaceId: "ws_mine", slug: "mine", role: "owner", kind: "personal" },
          { workspaceId: "ws_pin", slug: "context-lc", role: "member", kind: "shared", grantedNames: ["#reads-as-guest"] },
        ],
      };
    },
  };
  const texSession = await resolveSession(TOKEN_GUEST, null, stub);
  const door = sessionForSetup(texSession);
  assert.equal(door.workspaceId, "ws_pin");
  assert.deepEqual(door.scopes, ["context:read"], "read only, whatever the grant holds");
  assert.equal(door.scope, "team");
  assert.equal(door.grantedGroups.size, 0, "never the guest's names: the setup read's own rules judge it");
  assert.equal(door.setupRead, true);
  assert.equal(door.chatNames, null, "never a chat's names either");
  assert.equal(door.accessToken, TOKEN_GUEST, "the same proof, for the control plane's own check");
  assert.equal(sessionForSetup(door), null);
  for (const clientId of ["mcp_client_any", "context_console", "context_cards"]) {
    const other = await resolveSession(TOKEN_GUEST, null, { resolveSession: async () => ({ ...(await stub.resolveSession()), clientId }) });
    assert.equal(sessionForSetup(other), null, `${clientId} is not Tex`);
  }
  assert.deepEqual([...TEX_SETUP_CLIENTS].sort(), ["context_dreams", "context_heartbeat", "context_housekeeping", "context_routines", "context_texts", "context_texts_group"]);
});
