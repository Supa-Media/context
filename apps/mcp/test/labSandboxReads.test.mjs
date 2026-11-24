// A note a Lab test chat wrote is read back however the next call names it (Lab test chat, 2026-11-23: a job wrote six
// study notes with `context: "@ana"`, the caller's own workspace; a later job read them by plain path, with `read_notes`
// and `list_notes { prefix }`, got "not found" and an empty folder, and wrote all six again from scratch).
//
// What these prove: a plain path and `context` naming the caller's own workspace are one place in the test chat, both
// ways; `read_notes` answers a test chat's notes in place of the real "not found"; `list_notes` honours `prefix`.
// Fake ids, names and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-24): `placeOf` returning the context as given failed the first
// test; dropping the `read_notes` patch failed the second; reading only `folder` and `path` failed the third.

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { sandboxGate } from "../../../packages/lab/gateway/labSandbox/harness.js";
import { toolAnswer } from "../src/labSandbox/policy.js";
import { afterRead } from "../src/labSandbox/sandboxTools.js";
import { durableSql } from "./texStoreFixture.mjs";

const ONE = { kind: "one", owner: "person:ws_a", ledgerChat: "texts", people: [{ handle: "ana", name: "You" }], sandboxId: "0123456789abcdef", origin: "https://gateway.example.invalid" };

async function chat() {
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });
  const stub = { fetch: (request) => object.fetch(request) };
  await stub.fetch(new Request("https://lab-sandbox.internal/init", { method: "POST", body: JSON.stringify({ about: ONE, rows: [], history: [] }) }));
  return stub;
}

/** A gate for one text, its own workspace known as `@ana`, as `tools/session.js` sets it. */
function gateFor(stub, rowId, own = "@ana") {
  const gate = sandboxGate(stub, ONE, rowId, { arrivedAt: Date.now() });
  if (own) gate.ownWorkspace = own;
  return gate;
}

const NOT_FOUND = (path) => ({ type: "text", text: `path: ${path}\nerror: not found` });

test("a note written with the caller's own context is read by plain path, and the other way round", async () => {
  const stub = await chat();
  const first = gateFor(stub, "t1");
  await toolAnswer("write_note", { path: "Study/Book 1.md", content: "# Book 1", context: "@ana" }, first);
  await toolAnswer("write_note", { path: "Study/Book 2.md", content: "# Book 2" }, first);
  await first.flush();
  const next = gateFor(stub, "t2");
  assert.match((await toolAnswer("read_note", { path: "Study/Book 1.md" }, next)).content[0].text, /# Book 1$/);
  assert.match((await toolAnswer("read_note", { path: "Study/Book 2.md", context: "@ana" }, next)).content[0].text, /# Book 2$/);
  assert.match((await toolAnswer("read_note", { path: "Study/Book 1.md", context: "@ANA" }, next)).content[0].text, /# Book 1$/, "a handle is one name in any case");
  assert.equal(await toolAnswer("read_note", { path: "Study/Book 1.md", context: "@band" }, next), null, "another workspace's copy is not this one");
});

test("a row written under the own context before the workspace was known is still read by plain path", async () => {
  const stub = await chat();
  const early = gateFor(stub, "t1", null);
  await toolAnswer("write_note", { path: "Study/Book 3.md", content: "# Book 3", context: "@ana" }, early);
  await early.flush();
  const next = gateFor(stub, "t2");
  assert.match((await toolAnswer("read_note", { path: "Study/Book 3.md" }, next)).content[0].text, /# Book 3$/);
});

test("read_notes answers the test chat's notes in place of the real not found", async () => {
  const stub = await chat();
  const first = gateFor(stub, "t1");
  await toolAnswer("write_note", { path: "Study/Book 1.md", content: "# Book 1", context: "@ana" }, first);
  await first.flush();
  const next = gateFor(stub, "t2");
  const real = { content: [NOT_FOUND("Study/Book 1.md"), NOT_FOUND("Study/Other.md")], isError: true };
  const got = await afterRead("read_notes", { paths: ["Study/Book 1.md", "Study/Other.md"] }, real, next);
  assert.notEqual(got.isError, true, "one of them was read");
  assert.match(got.content[0].text, /^etag: lab-[0-9a-f]{8}\npath: Study\/Book 1\.md\n\n# Book 1$/);
  assert.equal(got.content[1].text, "path: Study/Other.md\nerror: not found", "a note the test chat never wrote stays not found");
});

test("list_notes by prefix names the test chat's notes under it", async () => {
  const stub = await chat();
  const first = gateFor(stub, "t1");
  await toolAnswer("write_note", { path: "Study/Book 1.md", content: "# Book 1", context: "@ana" }, first);
  await toolAnswer("write_note", { path: "tex/method.md", content: "steps" }, first);
  await first.flush();
  const next = gateFor(stub, "t2");
  const listed = await afterRead("list_notes", { prefix: "Study" }, { content: [{ type: "text", text: "(no visible notes under that prefix)" }] }, next);
  assert.match(listed.content.at(-1).text, /Study\/Book 1\.md/);
  assert.doesNotMatch(listed.content.at(-1).text, /tex\/method\.md/, "only notes under the prefix");
});
