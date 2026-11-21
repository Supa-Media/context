#!/usr/bin/env node
/**
 * Tex in a note's comments, end to end, live against staging.
 *
 * Proves the path the editor takes when a person highlights words and asks
 * "@Tex": the seeded alpha@supa.media persona signs in, mints the console's own
 * grant (as the app does), saves a note, asks Tex over `POST /tex/note-run`
 * and reads the streamed steps, answer, edit and done lines the way
 * `comments/tex/noteRun.ts` does. It then writes Tex's lines into the note's
 * comments block with the shared format (`packages/shared/src/comments.cjs`),
 * keeps the suggestion, saves the note through the gateway, reads it back, and
 * finds the run in `GET /tex/note-runs`.
 *
 * Everything it makes is a staging persona's fixture: the note is archived at
 * the end, whatever happened. Needs APP_ENV=staging, STAGING_CONVEX_DEPLOYMENT
 * and the staging deploy key (`CONVEX_DEPLOY_KEY`) for the persona's code.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { stagingSignInCode } from "./staging-sign-in-code.mjs";

const require = createRequire(import.meta.url);
const { addThread, appendEvent, applyChanges, keepSuggestion, parseComments } = require("../packages/shared/src/comments.cjs");

const GATEWAY = "https://mcp-staging.context.lc";
const PERSONA = "alpha@supa.media";
const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
assert.equal(process.env.APP_ENV, "staging", "APP_ENV must be staging");
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment), "STAGING_CONVEX_DEPLOYMENT is required");

const ref = (name) => makeFunctionReference(name);
const convex = new ConvexHttpClient(`https://${deployment}.convex.cloud`, { logger: false });
const pass = (label) => console.log(`PASS  ${label}`);
const path = `projects/tex-in-note-live/${randomBytes(4).toString("hex")}.md`;
const SENTENCE = "We meet on Saturday at the old library to plan the trip.";
const WORDS = "on Saturday";
let workspaceId = null;

/** One MCP tool call with the console grant; the tool's text, or a thrown error. */
async function tool(token, name, args) {
  const response = await fetch(`${GATEWAY}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${name} answered ${response.status}: ${raw.slice(0, 200)}`);
  const json = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(raw.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  assert.ok(!json.error, `${name} failed: ${JSON.stringify(json.error)}`);
  const text = (json.result?.content ?? []).map((part) => part.text ?? "").join("\n");
  assert.ok(!json.result?.isError, `${name} refused: ${text.slice(0, 300)}`);
  return text;
}

/** The note's Markdown and etag, from read_note's header lines. */
async function readNote(token) {
  const text = await tool(token, "fetch", { id: path });
  const etag = /^etag: (.+)$/m.exec(text)?.[1]?.trim();
  const split = text.indexOf("\n\n");
  return { etag, body: split === -1 ? "" : text.slice(split + 2) };
}

/** The NDJSON stream, line by line, as the editor reads it. */
async function noteRun(token, body) {
  const response = await fetch(`${GATEWAY}/tex/note-run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `note-run answered ${response.status}: ${raw.slice(0, 300)}`);
  assert.match(response.headers.get("content-type") ?? "", /ndjson/, "note-run is not NDJSON");
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

try {
  const signed = await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA, code: stagingSignInCode(PERSONA) } });
  assert.ok(signed.tokens?.token, "persona sign-in failed");
  convex.setAuth(signed.tokens.token);
  const mine = await convex.query(ref("functions/workspaces:listMyWorkspaces"), {});
  const personal = mine.find((entry) => entry.kind === "personal");
  assert.ok(personal, "the persona has no personal workspace; run Seed Staging Personas");
  workspaceId = personal.workspaceId;
  const { accessToken } = await convex.action(ref("functions/agentGrant:mintConsoleGrant"), { workspaceId });
  assert.ok(accessToken, "no console grant");
  pass(`signed in, console grant for @${personal.slug}`);

  await tool(accessToken, "write", { path, content: `# Trip\n\n${SENTENCE}\n` });
  const saved = await readNote(accessToken);
  assert.ok(saved.body.includes(SENTENCE), "the note did not save");
  pass("note saved through the gateway");

  // The editor's own request: the highlight, 200 characters either side with the comments block left out.
  const at = saved.body.indexOf(WORDS);
  const events = await noteRun(accessToken, {
    workspace: workspaceId,
    noteId: "",
    path,
    thread: "live1",
    anchor: { text: WORDS, before: saved.body.slice(Math.max(0, at - 200), at), after: saved.body.slice(at + WORDS.length, at + WORDS.length + 200) },
    ask: "make this Sunday instead",
    history: [],
    pending: null,
  });
  const kinds = events.map((event) => event.type);
  console.log(`  stream: ${kinds.join(" ")}`);
  const failed = events.find((event) => event.type === "error");
  assert.equal(failed, undefined, `the run ended in an error: ${failed?.message}`);
  assert.ok(events.some((event) => event.type === "step" && typeof event.label === "string"), "no step lines");
  const answer = events.findLast((event) => event.type === "answer");
  const edit = events.findLast((event) => event.type === "edit");
  const done = events.find((event) => event.type === "done");
  assert.ok(answer && answer.text.trim() !== "", "no answer");
  assert.ok(edit && /sunday/i.test(edit.replace), `no edit to Sunday: ${JSON.stringify(edit)}`);
  assert.ok(done && typeof done.runId === "string" && Array.isArray(done.sources), "no done line");
  assert.equal(kinds.at(-1), "done", "done is not the last line");
  pass(`Tex answered "${answer.text.slice(0, 80)}" and suggested "${edit.replace}"`);

  // What the editor writes: the person's comment, Tex's answer and suggestion, then Keep.
  const from = saved.body.indexOf(WORDS);
  const opened = addThread(saved.body, { from, to: from + WORDS.length, author: "@alpha", body: "@Tex make this Sunday instead", id: "live1" });
  assert.equal(opened.error, undefined, opened.error);
  let note = applyChanges(saved.body, opened.changes);
  for (const [kind, body] of [["comment", answer.text], ["suggestion", edit.replace]]) {
    const made = appendEvent(note, { thread: "live1", kind, author: "Tex", body });
    assert.equal(made.error, undefined, made.error);
    note = applyChanges(note, made.changes);
  }
  assert.equal(parseComments(note).threads[0]?.pending?.text, edit.replace, "the suggestion is not pending");
  const kept = keepSuggestion(note, { thread: "live1", author: "@alpha" });
  assert.equal(kept.error, undefined, kept.error);
  note = applyChanges(note, kept.changes);
  await tool(accessToken, "write", { path, content: note, expected_etag: saved.etag });
  const back = await readNote(accessToken);
  const thread = parseComments(back.body).threads.find((entry) => entry.id === "live1");
  assert.ok(thread, "the thread did not survive the save");
  assert.equal(thread.pending, null, "the kept suggestion is still pending");
  assert.ok(back.body.includes(edit.replace), "the kept words are not in the note");
  assert.ok(!back.body.includes(`${WORDS} at the old library`) || edit.replace.includes(WORDS), "the old words are still there");
  pass("Tex's lines and the Keep saved and read back");

  const runs = await fetch(`${GATEWAY}/tex/note-runs?workspace=${encodeURIComponent(workspaceId)}&noteId=&path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(runs.status, 200, `note-runs answered ${runs.status}`);
  const listed = (await runs.json()).runs;
  assert.ok(Array.isArray(listed), "note-runs has no runs list");
  const row = listed.find((entry) => entry.runId === done.runId);
  assert.ok(row, "the run is not in the note's log");
  assert.equal(row.ask, "make this Sunday instead");
  pass(`the run is in "Tex in this note" (${listed.length} row(s))`);
} finally {
  if (workspaceId !== null) {
    await convex
      .action(ref("functions/files:archiveEntry"), { workspaceId, path })
      .then(() => console.log(`  archived ${path}`))
      .catch((error) => console.log(`  could not archive ${path}: ${error.message}`));
  }
}
