/**
 * A failed call is a short code to its caller and one log line with the route and status, never the error's words
 * (Dev2, 2026-11-20: a computer job's save told the group "control plane unavailable" with no code, and nothing
 * logged which call failed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneError, createTransport, unusableAnswer } from "../src/controlPlane/client.js";
import { failureCode, failureText, logCallFailure } from "../src/mcp/publicError.js";
import { createNoteIdMethods } from "../src/controlPlane/noteIds.js";

const ENV = { CONTROL_PLANE_URL: "https://control-plane.test", GATEWAY_SECRET: "x".repeat(32) };

function capture(run) {
  const lines = [];
  const was = { error: console.error, log: console.log };
  console.error = (line) => lines.push(String(line));
  console.log = (line) => lines.push(String(line));
  return Promise.resolve()
    .then(run)
    .finally(() => Object.assign(console, was))
    .then((value) => ({ value, lines: lines.map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } }) }));
}

test("a status from the control plane is logged with its route and becomes a short code", async () => {
  const fetchImpl = async () => new Response("secret body /notes/private.md", { status: 503 });
  const { post } = createTransport(ENV, fetchImpl);
  const { value: error, lines } = await capture(() => post("/gateway/note-ids/adopt", { accessToken: "tok" }).catch((e) => e));
  assert.ok(error instanceof ControlPlaneError);
  assert.equal(error.route, "/gateway/note-ids/adopt");
  assert.equal(error.code, "CP-NOTE-IDS-ADOPT-503");
  const failed = lines.filter((line) => line.event === "control_plane_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].route, "/gateway/note-ids/adopt");
  assert.equal(failed[0].status, 503);
  assert.equal(failed[0].code, "CP-NOTE-IDS-ADOPT-503");
  assert.ok(!JSON.stringify(lines).includes("tok") && !JSON.stringify(lines).includes("private.md"));
});

test("a timeout and a transport failure each carry their route", async () => {
  const { post } = createTransport(ENV, async () => { throw new TypeError("boom https://x/?token=abc"); });
  const { value: error, lines } = await capture(() => post("/gateway/binding", {}).catch((e) => e));
  assert.equal(error.code, "CP-BINDING-REQUEST-FAILED");
  assert.ok(!JSON.stringify(lines).includes("abc"));
});

test("a declined adoption ({served: false}) is its own code, logged once", async () => {
  const fetchImpl = async () => Response.json({ served: false });
  const { post, required } = createTransport(ENV, fetchImpl);
  const methods = createNoteIdMethods({ post, required });
  const { value: error, lines } = await capture(() =>
    methods.noteIdAdopt("tok", "w1", { path: "a.md", noteId: "n", key: "k", etag: "e", at: 1 }).catch((e) => e),
  );
  assert.equal(error.code, "CP-NOTE-IDS-ADOPT-NOT-SERVED");
  assert.equal(lines.filter((line) => line.event === "control_plane_failed").length, 1);
});

test("a caller reads the code and a plain sentence, never the internal words", async () => {
  const error = unusableAnswer("/gateway/note-ids/wrote", { served: false }, "malformed");
  const { value: code, lines } = await capture(() => logCallFailure(error, { method: "tools/call", tool: "write" }));
  assert.equal(code, "CP-NOTE-IDS-WROTE-NOT-SERVED");
  const text = failureText(code);
  assert.match(text, /error CP-NOTE-IDS-WROTE-NOT-SERVED/);
  assert.doesNotMatch(text, /control plane/i);
  const line = lines.find((entry) => entry.event === "mcp_call_failed");
  assert.equal(line.tool, "write");
  assert.equal(line.route, "/gateway/note-ids/wrote");
  assert.equal(failureCode(new TypeError("x")), "INTERNAL-TYPEERROR");
  assert.equal(failureCode(new Error("x")), "INTERNAL");
});
