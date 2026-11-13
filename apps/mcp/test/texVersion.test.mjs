// Which Tex answered a turn, kept on its reply in the chat's ledger (Dev2, 2026-11-13: "we have to log which version
// of tex a message is going through in the history ledger"), so the Lab can replay an old text against what it ran on.
//
// Sabotage checks: drop `...versionField(env, production)` from the reply entry in `texEntryPoint/sendTheReply.js` and
// the second test fails; drop `delete entry.version` from the slim read in `texStore/ledger.js` and its last check does.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { texVersion } from "../src/agent/texVersion.js";

const CHAT = "sendblue:line:+15555550100";

test("a version names the commit, the Worker version and the setup, each only when it is the right shape", () => {
  const env = { TEX_CODE_VERSION: "0123456789ABCDEF0123456789abcdef01234567", CF_VERSION_METADATA: { id: "5b1d3e2a-0000-4c1d-9f00-aa11bb22cc33", tag: "", timestamp: "2026-11-13T22:00:00Z" } };
  assert.deepEqual(texVersion(env, { version: "a1b2c3d4e5f6" }), { code: "0123456789ab", deploy: "5b1d3e2a-0000-4c1d-9f00-aa11bb22cc33", setup: "a1b2c3d4e5f6" });
  assert.deepEqual(texVersion({ TEX_CODE_VERSION: "abc1234" }, null), { code: "abc1234" }, "a self-hosted deploy with no binding keeps the commit alone");
  assert.equal(texVersion({}, null), null, "nothing known, nothing kept");
  assert.equal(texVersion({ TEX_CODE_VERSION: "main; rm -rf" , CF_VERSION_METADATA: { id: "<script>" } }, { version: "not a hash!" }), null, "a value of the wrong shape is never kept");
});

test("a texted turn's reply keeps which Tex answered it, and a turn's own reads never see it", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const text = { id: `${now - 2_000}-000001`, at: now - 2_000, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi" };
    world.model.install([{ text: "Hi." }]);
    const env = { ...world.env, TEX_CODE_VERSION: "fedcba9876543210", CF_VERSION_METADATA: { id: "11111111-2222-4333-8444-555555555555" } };
    const asked = await request(env, TOKEN_TEXTS, "/agent", { question: text.text, conversation: "texts", covers: [text.id], chat: CHAT, recent: [text], turn: "turn-version-0001" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const ledger = ledgerFor(world.env, { person: "ws_egress" });
    const reply = (await ledger.read(ONE_TO_ONE_CHAT)).entries.find((entry) => entry.kind === "reply");
    assert.equal(reply.version.code, "fedcba987654");
    assert.equal(reply.version.deploy, "11111111-2222-4333-8444-555555555555");
    const slim = await ledger.read(ONE_TO_ONE_CHAT, { slim: true, kinds: ["reply"] });
    assert.equal(slim.entries[0].version, undefined, "a turn's own reads never carry it");
  } finally {
    world.restore();
  }
});
