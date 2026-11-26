/**
 * THE BENCH'S SETUP BUGS, PROVEN ON THEIR OWN (Training run v57vn7ws0rjavkdyw1rkzj7va58jh68f, 2026-11-19; TASK H).
 *
 * Four causes were scored as Tex "didn't act" misses: the simulated mailbox disagreed with the chat's setting
 * (`settingMailbox`, `inMailbox`), a failed tool's error was never kept with the row (`toolErrorsIn`, `safeError`), a
 * row's detail did not show those errors (`detailOf`), and a model call that failed or came back empty was graded as
 * Tex's (`modelFailuresIn`, `benchFailed`). Each is pinned here by what it answers.
 *
 * ## Sabotage record
 *
 *  1. `settingMailbox` reads the address with no mail word before it. → "Tex has Gmail (john@lantern.example)..." and
 *     "...her Gmail (maya@fernway.example)..." lose their address and fail.
 *  2. `inMailbox` stops moving the old address out of `to`. → "inMailbox moves the address and replaces the old one
 *     in to..." fails.
 *  3. `toolErrorsIn` drops the `is_error` check, so every result counts. → "a successful result is not listed" fails.
 *  4. `toolErrorsIn` stops its `Set`-like dedupe. → "duplicate error lines are kept once" fails.
 *  5. `safeError` stops hiding token-shaped runs. → "a 40-character token-like run is hidden" fails.
 *  6. `modelFailuresIn` ignores a non-200 status. → "a failed model call (status 500) is a bench failure" fails.
 *  7. `detailOf` drops the `errors:` line. → "the errors line follows the steps line" fails.
 *  8. `benchFailed` returns a string for a right row. → "a right row is not a bench failure" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { inMailbox, settingMailbox } from "../mailbox.mjs";
import { modelFailuresIn, refusalOf, safeError, toolErrorsIn, MAX_ERRORS } from "../toolErrors.mjs";
import { benchFailed } from "../setsFdRows.mjs";
import { detailOf } from "../../../../scripts/tex-lab-run.mjs";

const SEND_CALL = (id, name = "send_email") => ({
  status: 200,
  messages: [],
  answer: { content: [{ type: "tool_use", id, name, input: {} }] },
});

/** A call whose next call was shown `result` for the tool use `id`. */
function resultCall(id, result) {
  return {
    status: 200,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, ...result }] }],
    answer: { content: [{ type: "text", text: "ok" }] },
  };
}

test("the mailbox is the address the chat's setting names, after its mail word", () => {
  assert.equal(settingMailbox("Maya runs Fernway... Tex has her Gmail (maya@fernway.example), Calendar"), "maya@fernway.example");
  assert.equal(settingMailbox("Tex has Gmail (john@lantern.example), Calendar"), "john@lantern.example");
  assert.equal(settingMailbox("Tex has Gmail (JOHN@Lantern.Example), Calendar"), "john@lantern.example", "lowercased");
  assert.equal(settingMailbox("Tex has Gmail, Calendar"), null, "Gmail with no address");
  assert.equal(settingMailbox(""), null);
  assert.equal(settingMailbox(undefined), null);
});

test("inMailbox moves the address and replaces the old one in to, keeping the other recipients", () => {
  const mail = [
    { address: "maya@example.invalid", id: "a", to: "maya@example.invalid, bob@x.example", subject: "one" },
    { address: "maya@fernway.example", id: "b", to: "maya@fernway.example", subject: "already there" },
  ];
  const moved = inMailbox(mail, "maya@fernway.example");
  assert.equal(moved[0].address, "maya@fernway.example");
  assert.equal(moved[0].to, "maya@fernway.example, bob@x.example", "the old address is replaced, bob is kept");
  assert.equal(moved[0].subject, "one", "the rest of the mail is kept");
  assert.equal(moved[1], mail[1], "mail already at the address is unchanged");
  assert.equal(mail[0].address, "maya@example.invalid", "the input is not mutated");
});

test("inMailbox with no address hands the mail back as it is", () => {
  const mail = [{ address: "maya@example.invalid", id: "a", to: "maya@example.invalid" }];
  assert.equal(inMailbox(mail, null), mail);
});

test("a tool that failed is listed with its name, and a successful result is not", () => {
  const calls = [
    SEND_CALL("t1"),
    resultCall("t1", { is_error: true, content: "Not sent: no sender" }),
    SEND_CALL("t2", "search_email"),
    resultCall("t2", { content: "found 2" }),
  ];
  assert.deepEqual(toolErrorsIn(calls), ["send_email: Not sent: no sender"]);
});

test("duplicate error lines are kept once, and at most MAX_ERRORS lines", () => {
  const same = [SEND_CALL("d1"), resultCall("d1", { is_error: true, content: "Not sent: no sender" }), SEND_CALL("d2"), resultCall("d2", { is_error: true, content: "Not sent: no sender" })];
  assert.deepEqual(toolErrorsIn(same), ["send_email: Not sent: no sender"]);

  const many = [];
  for (let i = 0; i < MAX_ERRORS + 2; i += 1) {
    many.push(SEND_CALL(`m${i}`), resultCall(`m${i}`, { is_error: true, content: `error ${i}` }));
  }
  const lines = toolErrorsIn(many);
  assert.equal(lines.length, MAX_ERRORS);
  assert.equal(lines[0], "send_email: error 0");
});

test("safeError hides a 40-character token-like run, cuts a link to its host, folds whitespace and clips to 160", () => {
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN";
  assert.equal(token.length, 40);
  assert.equal(safeError(`bad key ${token} here`), "bad key [hidden] here");
  assert.equal(safeError("see https://host.example/path/to/x?y=secret for it"), "see https://host.example/… for it");
  assert.equal(safeError("a \n\n  b\t c"), "a b c");
  const clipped = safeError("word ".repeat(100));
  assert.equal(clipped.length, 160);
  assert.ok(clipped.endsWith("…"));
});

test("a failed model call, and a front-door answer with no words and no tool call, are bench failures", () => {
  const isFrontDoor = (call) => call.front === true;
  assert.deepEqual(modelFailuresIn([{ status: 500, answer: { content: [] } }], isFrontDoor), ["a model call failed (status 500)"]);
  const empty = { status: 200, front: true, answer: { content: [{ type: "text", text: "  " }] } };
  assert.deepEqual(modelFailuresIn([empty], isFrontDoor), ["the model gave an empty answer"]);
  assert.deepEqual(modelFailuresIn([{ status: 200, front: true, answer: { content: [{ type: "text", text: "hi" }] } }], isFrontDoor), []);
  assert.deepEqual(modelFailuresIn([{ status: 200, front: true, answer: { content: [{ type: "tool_use", id: "x", name: "n", input: {} }] } }], isFrontDoor), []);
  assert.deepEqual(modelFailuresIn([{ status: 200, front: false, answer: { content: [{ type: "text", text: "  " }] } }], isFrontDoor), [], "not the front door");
});

test("a refused model call says what the provider said, not only its status", () => {
  const isFrontDoor = () => true;
  const anthropic = { status: 400, answer: { content: null, error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } } };
  assert.deepEqual(modelFailuresIn([anthropic], isFrontDoor), ["a model call failed (status 400: invalid_request_error: prompt is too long: 210000 tokens > 200000 maximum)"]);
  assert.equal(refusalOf({ errors: [{ code: 2003, message: "Rate limited" }] }), "2003: Rate limited");
  assert.equal(refusalOf("upstream timed out"), "upstream timed out");
  const edits = { status: 400, answer: { content: null, error: { type: "invalid_request_error", message: "context_management: Extra inputs are not permitted" } } };
  const ok = { status: 200, answer: { content: [{ type: "text", text: "hi" }] } };
  assert.deepEqual(modelFailuresIn([edits, ok], isFrontDoor), [], "the gateway resends without context editing, and that went through");
  assert.equal(modelFailuresIn([edits], isFrontDoor).length, 1, "no resend that went through: still a failure");
  assert.equal(modelFailuresIn([anthropic, ok], isFrontDoor).length, 1, "a refusal the gateway does not resend still counts");
  assert.equal(refusalOf({ content: null }), "");
});

test("a row's detail puts the errors line right after the steps line", () => {
  const { detail } = detailOf({
    toolErrors: ["send_email: Not sent: no sender"],
    steps: "tools send_email failed | outcome: replied",
  });
  const lines = detail.split("\n");
  const at = lines.indexOf("steps: tools send_email failed | outcome: replied");
  assert.ok(at >= 0, "the steps line is there");
  assert.equal(lines[at + 1], "errors: send_email: Not sent: no sender");
});

test("a row the bench failed is named as the bench's, and a right row is not", () => {
  const failed = benchFailed({ right: false, bench: ["the model gave an empty answer"] });
  assert.ok(failed.startsWith("the bench failed, not Tex: the model gave an empty answer"));
  assert.equal(benchFailed({ right: true, bench: ["the model gave an empty answer"] }), null);
});
