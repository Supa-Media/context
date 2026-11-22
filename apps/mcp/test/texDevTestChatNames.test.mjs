/**
 * tex_dev `test_chat` (Dev2, 2026-11-22: "sandbox" meant both a pull request's preview and the Lab's test texts; it
 * now means only the preview). The action and its id are `test_chat` and `testChatId`; the old `sandbox` and
 * `sandboxId` still answer, and every answer speaks the new names, links included.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-22):
 *   tool.js dropping `case OLD_TEST_CHAT_ACTION`        "the old action name still answers" fails
 *   testChatArgs not mapping testChatId to sandboxId    "testChatId reaches the route as its sandboxId" fails
 *   testChatAnswer leaving keys as they are             "answers speak the new names" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { testChatAnswer, testChatArgs } from "../../../packages/lab/gateway/texDev/testChatNames.js";

const tool = () => {
  const controlPlane = new Proxy({}, { get: () => async () => ({ status: "ok" }) });
  return createTexDev({ env: {}, session: { workspaceSlug: "context-lc", scope: "private", role: "editor" }, controlPlane });
};

test("the guide and the action list name test_chat, never sandbox as an action", async () => {
  const text = guideText();
  assert.match(text, /^- test_chat \{ op:/m);
  assert.doesNotMatch(text, /^- sandbox /m);
  assert.match(text, /`test_chat open`/);
  const unknown = await tool()("no_such_action", {});
  assert.match(unknown.content[0].text, /test_chat/);
  assert.doesNotMatch(unknown.content[0].text, /\bsandbox\b/);
});

test("the new action answers, and the old action name still answers, both in the new names", async () => {
  for (const action of ["test_chat", "sandbox"]) {
    const answer = await tool()(action, { op: "send", text: "hi" });
    assert.ok(answer.isError, `${action}: ${JSON.stringify(answer)}`);
    assert.match(answer.content[0].text, /\{ testChatId \}/, action);
    assert.doesNotMatch(answer.content[0].text, /sandboxId/, action);
  }
});

test("testChatId reaches the route as its sandboxId; an old sandboxId is passed as it is", () => {
  assert.deepEqual(testChatArgs({ op: "get", testChatId: "0123456789abcdef" }), { op: "get", sandboxId: "0123456789abcdef" });
  assert.deepEqual(testChatArgs({ op: "get", sandboxId: "0123456789abcdef" }), { op: "get", sandboxId: "0123456789abcdef" });
  assert.deepEqual(testChatArgs(undefined), {});
});

test("answers speak the new names: keys, hints and Lab links", () => {
  const said = testChatAnswer({
    sandboxId: "0123456789abcdef",
    link: "https://context.example/lab?sandbox=0123456789abcdef&v=v1",
    next: 'wait { sandboxId, msgId: "m1" } for the rest; sandbox again re-runs it',
    list: [{ sandboxId: "fedcba9876543210", text: "the sandbox stays a word in a text" }],
  });
  assert.deepEqual(said, {
    testChatId: "0123456789abcdef",
    link: "https://context.example/lab?testchat=0123456789abcdef&v=v1",
    next: 'wait { testChatId, msgId: "m1" } for the rest; test_chat again re-runs it',
    list: [{ testChatId: "fedcba9876543210", text: "the sandbox stays a word in a text" }],
  });
});
