// A Lab test chat copied from a real group chat runs on the Lab user's own token, which reads nobody's mail, so a
// shared mailbox's search failed there (2026-11-26). `labChatMail` names the chat on every mail read, so the control
// plane answers it as the chat's own read (apps/convex `labChatMailClearance`).
// Sabotage: return `controlPlane` unchanged from `labChatMail` → the first test fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { labChatMail } from "../../../packages/lab/gateway/labSandbox/chatMail.js";

const KEY = "a".repeat(64);

function fakeControlPlane() {
  const asked = [];
  return {
    asked,
    marker: "kept",
    async personMailSearch(token, workspace, search) {
      asked.push({ kind: "search", token, workspace, search, self: this.marker });
      return { ok: true, results: [] };
    },
    async personMailRead(token, workspace, address, id, options) {
      asked.push({ kind: "read", token, workspace, address, id, options });
      return { ok: true, message: { id } };
    },
    async sendPersonEmail() {
      asked.push({ kind: "send" });
      return { ok: true, from: "x@example.com" };
    },
  };
}

test("each mail read names the chat; the token, workspace and arguments stay as they were", async () => {
  const cp = fakeControlPlane();
  const lab = labChatMail(cp, KEY);
  await lab.personMailSearch("tok", "ws", { query: "intake", address: "a@example.com" });
  await lab.personMailRead("tok", "ws", "a@example.com", "m1", { attachment: 2 });
  assert.deepEqual(cp.asked[0], { kind: "search", token: "tok", workspace: "ws", search: { query: "intake", address: "a@example.com", labChat: KEY }, self: "kept" });
  assert.deepEqual(cp.asked[1], { kind: "read", token: "tok", workspace: "ws", address: "a@example.com", id: "m1", options: { attachment: 2, labChat: KEY } });
});

test("everything else reaches the control plane untouched, and a bad key changes nothing", async () => {
  const cp = fakeControlPlane();
  await labChatMail(cp, KEY).sendPersonEmail();
  assert.deepEqual(cp.asked, [{ kind: "send" }]);
  assert.equal(labChatMail(cp, KEY).marker, "kept");
  assert.equal(labChatMail(cp, "not-a-key"), cp);
  assert.equal(labChatMail(cp, undefined), cp);
});
