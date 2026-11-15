import assert from "node:assert/strict";
import test from "node:test";

import { describeError, errorDetail, RequestError, statusForCode } from "../container/errors.mjs";
import { formatLog } from "../container/log.mjs";
import { OPS, opFor, parseChat, parseLine } from "../container/validate.mjs";

const LINE = "+15550100123";
const CHAT = "any;-;+15550100999";

function sdkError(code, message = "private text +15550100999 hello") {
  return Object.assign(new Error(message), { code, retryable: code === "burstRateExceeded" });
}

test("refusal and validation codes are 4xx; upstream trouble is 5xx", () => {
  assert.equal(statusForCode("invalidArgument"), 400);
  assert.equal(statusForCode("chatNotFound"), 404);
  assert.equal(statusForCode("preconditionFailed"), 409);
  assert.equal(statusForCode("burstRateExceeded"), 429);
  assert.equal(statusForCode("recipientLocked"), 422);
  assert.equal(statusForCode("unauthenticated"), 502);
  assert.equal(statusForCode("serviceUnavailable"), 503);
  assert.equal(statusForCode("timeout"), 504);
  assert.equal(statusForCode("somethingNew"), 502);
});

test("an SDK error becomes its status and only its code in the body", () => {
  const { status, body } = describeError(sdkError("chatNotFound"));
  assert.equal(status, 404);
  assert.deepEqual(body, { ok: false, status: 404, error: "chatNotFound", retryable: false });
  assert.equal(JSON.stringify(body).includes("15550100999"), false);
  assert.equal(JSON.stringify(body).includes("hello"), false);
});

test("a retryable rate limit says so", () => {
  const { status, body } = describeError(sdkError("burstRateExceeded"));
  assert.equal(status, 429);
  assert.equal(body.retryable, true);
});

test("an error without a code, such as a transport failure, is 502 with code unknown", () => {
  const { status, body } = describeError(new TypeError("fetch failed to +15550100999"));
  assert.equal(status, 502);
  assert.equal(body.error, "unknown");
  assert.equal(JSON.stringify(body).includes("15550100999"), false);
});

test("the bridge's own refusals keep their status and carry their code", () => {
  const { status, body } = describeError(new RequestError(400, "invalid_line"));
  assert.equal(status, 400);
  assert.deepEqual(body, { ok: false, status: 400, error: "invalid_line" });
});

test("every op parses a well-formed body into its arguments", () => {
  const cases = {
    "send/text": { line: LINE, chat: CHAT, text: "hi", linkPreview: true, effect: "confetti", replyTo: "msg-1" },
    "send/attachment": { line: LINE, chat: CHAT, name: "a.png", mimeType: "image/png", data: "AAAA" },
    "send/multipart": { line: LINE, chat: CHAT, parts: [{ text: "look" }, { attachment: { name: "a.png", mimeType: "image/png", url: "https://example.com/a.png" } }] },
    "send/app": { line: LINE, chat: CHAT, card: { appName: "Tex", extensionBundleId: "com.example.ext", teamId: "TEAM1", url: "https://example.com/card" } },
    edit: { line: LINE, chat: CHAT, guid: "msg-1", text: "new" },
    unsend: { line: LINE, chat: CHAT, guid: "msg-1" },
    react: { line: LINE, chat: CHAT, guid: "msg-1", kind: "love", on: true },
    typing: { line: LINE, chat: CHAT, on: false },
    read: { line: LINE, chat: CHAT },
    contact: { line: LINE, chat: CHAT },
    "chat/resolve": { line: LINE, address: "+15550100999" },
    "group/members": { line: LINE, chat: CHAT },
    "group/remove": { line: LINE, chat: CHAT, address: "+15550100999" },
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(OPS).sort());
  for (const [name, body] of Object.entries(cases)) {
    const parsed = OPS[name].parse(body);
    assert.equal(parsed.line, LINE, name);
  }
});

test("group/remove takes one phone or email to take out, nothing else", () => {
  assert.deepEqual(OPS["group/remove"].parse({ line: LINE, chat: CHAT, address: "+15550100999" }), { line: LINE, chat: CHAT, address: "+15550100999" });
  assert.throws(() => OPS["group/remove"].parse({ line: LINE, chat: CHAT }), { code: "invalid_address" });
  assert.throws(() => OPS["group/remove"].parse({ line: LINE, chat: CHAT, address: ["+15550100999"] }), { code: "invalid_address" });
});

test("a body that is not an object is refused before any call", () => {
  for (const name of ["send/text", "edit", "read", "chat/resolve"]) {
    assert.throws(() => OPS[name].parse(null), { status: 400, code: "invalid_body" }, name);
    assert.throws(() => OPS[name].parse([]), { status: 400 }, name);
  }
});

test("the line must be E.164, and the chat must be a chat guid", () => {
  assert.throws(() => parseLine("15550100123"), { code: "invalid_line" });
  assert.throws(() => parseLine("+0555"), { code: "invalid_line" });
  assert.throws(() => parseChat("+15550100999"), { code: "invalid_chat" });
  assert.throws(() => OPS.read.parse({ line: LINE, chat: "nope" }), { code: "invalid_chat" });
});

test("text, guid and effect are bounded", () => {
  assert.throws(() => OPS["send/text"].parse({ line: LINE, chat: CHAT, text: "" }), { code: "invalid_text" });
  assert.throws(() => OPS["send/text"].parse({ line: LINE, chat: CHAT, text: "x".repeat(10001) }), { code: "invalid_text" });
  assert.throws(() => OPS["send/text"].parse({ line: LINE, chat: CHAT, text: "hi", effect: "nope" }), { code: "invalid_effect" });
  assert.throws(() => OPS.unsend.parse({ line: LINE, chat: CHAT, guid: "bad guid/../" }), { code: "invalid_guid" });
});

test("a file needs exactly one of data or url", () => {
  const base = { line: LINE, chat: CHAT, name: "a.png", mimeType: "image/png" };
  assert.throws(() => OPS["send/attachment"].parse(base), { code: "attachment_needs_data_or_url" });
  assert.throws(
    () => OPS["send/attachment"].parse({ ...base, data: "AAAA", url: "https://example.com/a.png" }),
    { code: "attachment_needs_data_or_url" },
  );
});

test("base64 must be well formed and under the size ceiling", () => {
  const base = { line: LINE, chat: CHAT, name: "a.png", mimeType: "image/png" };
  assert.throws(() => OPS["send/attachment"].parse({ ...base, data: "AAA" }), { code: "invalid_data" });
  assert.throws(() => OPS["send/attachment"].parse({ ...base, data: "A!AA" }), { code: "invalid_data" });
  const tooBig = "A".repeat(4 * Math.ceil((25 * 1024 * 1024 + 3) / 3));
  assert.throws(() => OPS["send/attachment"].parse({ ...base, data: tooBig }), { code: "too_large_data" });
});

test("a file name cannot carry a path", () => {
  assert.throws(
    () => OPS["send/attachment"].parse({ line: LINE, chat: CHAT, name: "../../etc", mimeType: "image/png", data: "AAAA" }),
    { code: "invalid_name" },
  );
});

test("only https URLs without credentials are accepted", () => {
  const base = { line: LINE, chat: CHAT, name: "a.png", mimeType: "image/png" };
  for (const url of ["http://example.com/a.png", "https://user:pw@example.com/a.png", "file:///etc/passwd", "not a url"]) {
    assert.throws(() => OPS["send/attachment"].parse({ ...base, url }), { code: "invalid_url" }, url);
  }
});

test("a reaction of kind emoji needs its emoji; kinds are closed", () => {
  assert.throws(
    () => OPS.react.parse({ line: LINE, chat: CHAT, guid: "msg-1", kind: "emoji", on: true }),
    { code: "missing_emoji" },
  );
  assert.throws(
    () => OPS.react.parse({ line: LINE, chat: CHAT, guid: "msg-1", kind: "sticker", on: true }),
    { code: "invalid_kind" },
  );
});

test("the on flag must be a boolean", () => {
  assert.throws(() => OPS.typing.parse({ line: LINE, chat: CHAT, on: "yes" }), { code: "invalid_on" });
});

test("a multipart body has between one and twenty parts", () => {
  assert.throws(() => OPS["send/multipart"].parse({ line: LINE, chat: CHAT, parts: [] }), { code: "invalid_parts" });
});

test("an address must be E.164 or an email", () => {
  assert.throws(() => OPS["chat/resolve"].parse({ line: LINE, address: "not an address" }), { code: "invalid_address" });
  assert.equal(OPS["chat/resolve"].parse({ line: LINE, address: "alice@example.com" }).address, "alice@example.com");
});

test("opFor only names the ops in the table", () => {
  assert.ok(opFor("send/text"));
  assert.equal(opFor("__proto__"), undefined);
  assert.equal(opFor("constructor"), undefined);
  assert.equal(opFor("health"), undefined);
});

test("a provider failure's reason reaches the log with what it quotes, its numbers and its addresses taken out", () => {
  const error = Object.assign(new Error('link preview "see you at 5, Bob" refused for any;-;+15550100999 and bob@example.com'), {
    code: "invalidArgument",
    context: { field: "enable_link_preview" },
    grpcCode: 3,
    requestId: "req_01-abc",
  });
  const detail = errorDetail(error);
  assert.deepEqual({ ...detail, detail: undefined }, { field: "enable_link_preview", request: "req_01-abc", grpc: 3, detail: undefined });
  const line = formatLog({ event: "op", op: "send/text", ok: false, status: 400, error: "invalidArgument", ...detail });
  for (const secret of ["see you", "Bob", "0100999", "bob@example.com"]) assert.ok(!line.includes(secret), secret);
  assert.ok(line.includes("link preview"));
  assert.ok(line.includes('"field":"enable_link_preview"'));
});

test("a refusal of our own carries no provider detail", () => {
  assert.deepEqual(errorDetail(new RequestError(400, "invalid_chat")), {});
  assert.deepEqual(errorDetail(Object.assign(new Error("x"), { context: { field: "a b c" }, requestId: "has space" })), { detail: "x" });
});
