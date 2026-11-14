/**
 * The first graph nodes (`src/agent/graph/nodes/`): each is `async (input, io) => output`, with its live things
 * in `io.ctx`. These tests hand fakes through `io.ctx` and check each node's output on the happy path and on the
 * empty or null path, then that no node imports a sibling, so each runs on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { jobcheck, checkOf } from "../src/agent/graph/nodes/jobcheck.js";
import { handback } from "../src/agent/graph/nodes/handback.js";
import { mailadv } from "../src/agent/graph/nodes/mailadv.js";
import { notify } from "../src/agent/graph/nodes/notify.js";
import { ADVISOR_MAIL_PROMPT } from "../src/agent/advisorRoles/jobMail.js";
import { attentionEntry, attentionHeading, attentionPath, ATTENTION_SETTINGS_PATH, WAITING } from "../src/agent/attention.js";
import { DEFAULT_BUILTIN_MODEL } from "../src/agent/builtin.js";

const NODES = new URL("../src/agent/graph/nodes/", import.meta.url);
const job = { title: "Renew passport", brief: "Fill in the renewal form", doneWhen: "the form is submitted", attempt: 1 };

// --- jobcheck ---------------------------------------------------------------

test("jobcheck: a verdict with advice and thinking comes back as plain fields, and checkOf maps it back", async () => {
  const meters = [];
  const request = async () => ({ text: "VERDICT: keep going\nADVICE: try the email link instead", content: [{ type: "thinking", thinking: "the form is still open" }] });
  const io = { ctx: { jobCheck: { live: { messages: [] }, model: "fake-advisor", effort: "low", request, meter: async (...args) => meters.push(args) } } };
  const output = await jobcheck({ job, answer: "I'll start the form", exhausted: false }, io);
  assert.deepEqual(output, { verdict: "keep_going", advice: "try the email link instead", thinking: "the form is still open" });
  assert.deepEqual(checkOf(output), { verdict: "keep_going", advice: "try the email link instead", thinking: "the form is still open" });
  assert.equal(meters.length, 1);
});

test("jobcheck: a verdict with no advice or thinking gives empty strings, and checkOf leaves them out", async () => {
  const io = { ctx: { jobCheck: { live: {}, model: "fake-advisor", request: async () => ({ text: "VERDICT: done" }), meter: async () => {} } } };
  const output = await jobcheck({ job, answer: "all submitted", exhausted: false }, io);
  assert.deepEqual(output, { verdict: "done", advice: "", thinking: "" });
  assert.deepEqual(checkOf(output), { verdict: "done" });
});

test("jobcheck: a request that fails, or no model, gives verdict none and checkOf null", async () => {
  const metered = [];
  const failing = { ctx: { jobCheck: { live: {}, model: "fake-advisor", request: async () => { throw new Error("down"); }, meter: async (...args) => metered.push(args) } } };
  const output = await jobcheck({ job, answer: "x", exhausted: false }, failing);
  assert.deepEqual(output, { verdict: "none", advice: "", thinking: "" });
  assert.equal(checkOf(output), null);
  assert.equal(metered[0][1], true, "the failure is metered");

  const noModel = { ctx: { jobCheck: { live: {}, model: undefined, request: async () => ({ text: "VERDICT: done" }) } } };
  assert.deepEqual(await jobcheck({ job, answer: "x", exhausted: false }, noModel), { verdict: "none", advice: "", thinking: "" });
});

test("jobcheck: an answer naming no verdict is none", async () => {
  const io = { ctx: { jobCheck: { live: {}, model: "fake-advisor", request: async () => ({ text: "I think it is probably fine." }), meter: async () => {} } } };
  assert.equal((await jobcheck({ job, answer: "x", exhausted: false }, io)).verdict, "none");
});

// --- handback ---------------------------------------------------------------

const judgeReply = (asks) => async () => ({ text: JSON.stringify({ asks }) });

test("handback: an H-code names its notice and is logged as codes only", async () => {
  const lines = [];
  const io = {
    ctx: { handback: { config: { fake: true }, request: judgeReply([{ code: "H9", quote: "which email should I use?" }]), metadata: { workspace: "ws_test" }, log: (line) => lines.push(line) } },
  };
  const output = await handback({ question: "send the receipt", answer: "Which email should I use?", steps: [{ name: "search", ok: true }] }, io);
  assert.equal(output.judged, true);
  assert.deepEqual(output.codes, ["H9"]);
  assert.equal(output.sentBack, "H9");
  assert.match(output.notice, /^Before this goes: you ask for something you can find/);
  assert.deepEqual(JSON.parse(lines[0]), { event: "handback_judged", workspace: "ws_test", judged: true, codes: ["H9"], sentBack: "H9" });
});

test("handback: fair asks only are judged but not sent back", async () => {
  const lines = [];
  const io = { ctx: { handback: { config: { fake: true }, request: judgeReply([{ code: "Y1", quote: "the card needs paying" }]), log: (line) => lines.push(line) } } };
  const output = await handback({ question: "renew it", answer: "Pay the fee?", steps: [] }, io);
  assert.deepEqual(output, { judged: true, codes: ["Y1"], sentBack: "", notice: "" });
  assert.equal(JSON.parse(lines[0]).sentBack, null);
});

test("handback: a judge that fails is judged false, with nothing sent back", async () => {
  const lines = [];
  const io = { ctx: { handback: { config: { fake: true }, request: async () => { throw new Error("down"); }, log: (line) => lines.push(line) } } };
  const output = await handback({ question: "q", answer: "a", steps: [] }, io);
  assert.deepEqual(output, { judged: false, codes: [], sentBack: "", notice: "" });
  assert.equal(JSON.parse(lines[0]).judged, false);
});

test("handback: no model road runs no judge and logs nothing", async () => {
  const lines = [];
  let called = false;
  const io = { ctx: { handback: { config: undefined, request: async () => { called = true; return { text: "{}" }; }, log: (line) => lines.push(line) } } };
  assert.deepEqual(await handback({ question: "q", answer: "a", steps: [] }, io), { judged: false, codes: [], sentBack: "", notice: "" });
  assert.equal(called, false);
  assert.deepEqual(lines, []);
});

// --- mailadv ----------------------------------------------------------------

const mailInput = { jobId: "job_abcdefgh", title: "Renew passport", brief: "Fill in the form", doneWhen: "submitted", from: "passport-form", question: "Who has the photo?", noteText: "# Renew passport\n" };

test("mailadv: the production advisor answers, trimmed, and its usage is recorded", async () => {
  const asked = [];
  const recorded = [];
  const env = { AI: { run: async () => ({}) } };
  const io = {
    ctx: {
      mailadv: {
        production: { advisor: "@cf/test/advisor", efforts: {} },
        env,
        request: async (params) => { asked.push(params); return { text: "  Ask Tex to find the photo.  ", usage: { input: 5, output: 7 } }; },
        controlPlane: { recordBuiltinUsage: async (...args) => recorded.push(args) },
        session: { accessToken: "tok", workspaceId: "ws_1" },
      },
    },
  };
  const output = await mailadv(mailInput, io);
  assert.deepEqual(output, { model: "@cf/test/advisor", words: "Ask Tex to find the photo.", ok: true });
  assert.equal(asked[0].model, "@cf/test/advisor");
  assert.ok(asked[0].system.includes(ADVISOR_MAIL_PROMPT), "the mail role's instructions are the system words");
  assert.match(asked[0].messages[0].text, /Job: Renew passport/);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0][0], "tok");
  assert.equal(recorded[0][1], "ws_1");
  assert.equal(recorded[0][2].model, "@cf/test/advisor");
  assert.equal(recorded[0][2].failed, false);
});

test("mailadv: with no production model the built-in model answers", async () => {
  const io = { ctx: { mailadv: { production: null, env: { AI: { run: async () => ({}) } }, request: async () => ({ text: "Go on." }), controlPlane: null, session: { workspaceId: "ws_1" } } } };
  assert.deepEqual(await mailadv(mailInput, io), { model: DEFAULT_BUILTIN_MODEL, words: "Go on.", ok: true });
});

test("mailadv: a failed call is ok false with no words, and the failure is recorded", async () => {
  const recorded = [];
  const io = {
    ctx: {
      mailadv: {
        production: { model: "@cf/test/advisor" },
        env: { AI: { run: async () => ({}) } },
        request: async () => { throw new Error("down"); },
        controlPlane: { recordBuiltinUsage: async (...args) => recorded.push(args) },
        session: { accessToken: "tok", workspaceId: "ws_1" },
      },
    },
  };
  assert.deepEqual(await mailadv(mailInput, io), { model: "@cf/test/advisor", words: "", ok: false });
  assert.equal(recorded[0][2].failed, true);
});

test("mailadv: no model this deployment can call is empty and asks nobody", async () => {
  let asked = false;
  const io = { ctx: { mailadv: { production: { advisor: "anthropic/claude-haiku-5-5" }, env: {}, request: async () => { asked = true; return { text: "x" }; }, session: {} } } };
  assert.deepEqual(await mailadv(mailInput, io), { model: "", words: "", ok: false });
  assert.equal(asked, false);
});

// --- notify -----------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 12, 0);

/** A tiny note store behind `read_note` and `write_note`, as the check-in's dispatch sees it. */
function noteStore(files) {
  const writes = [];
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      const file = files[args.path];
      if (file === undefined) return { isError: true, content: [{ type: "text", text: `not found: ${args.path}` }] };
      return { content: [{ type: "text", text: `etag: ${file.etag}\n\n${file.body}` }] };
    }
    if (name === "write_note") {
      writes.push(args);
      files[args.path] = { etag: `${args.expected_etag ?? "new"}-next`, body: args.content };
      return { content: [{ type: "text", text: "saved" }] };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { dispatch, writes };
}

test("notify: one waiting ping is texted once and its log line is marked texted", async () => {
  const today = attentionPath(NOW, "UTC");
  const log = attentionHeading(NOW, "UTC") + "\n" + attentionEntry({ id: "p_0123456789ab", now: NOW, timeZone: "UTC", from: "Renewal bot", urgency: "asked", message: "The form needs your photo.", why: null, status: WAITING });
  const files = { [today]: { etag: "e1", body: log } };
  const { dispatch, writes } = noteStore(files);
  const output = await notify({ now: NOW, timeZone: "UTC", onlyEmergencies: false }, { ctx: { notify: { dispatch, store: {} } } });
  assert.deepEqual(output, { to: "send", answer: "Renewal bot: The form needs your photo.", count: 1 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, today);
  assert.match(writes[0].content, /\*\*Ping:\*\* p_0123456789ab · asked · texted /);
});

test("notify: nothing waiting is quiet", async () => {
  const { dispatch, writes } = noteStore({ [ATTENTION_SETTINGS_PATH]: { etag: "s1", body: "---\ntolerance: strict\n---\n" } });
  const output = await notify({ now: NOW, timeZone: "UTC", onlyEmergencies: false }, { ctx: { notify: { dispatch, store: {} } } });
  assert.deepEqual(output, { to: "quiet", answer: "", count: 0 });
  assert.deepEqual(writes, []);
});

test("notify: a ping from yesterday that is still waiting is found too", async () => {
  const yesterday = attentionPath(NOW - DAY_MS, "UTC");
  const log = attentionHeading(NOW - DAY_MS, "UTC") + "\n" + attentionEntry({ id: "p_aaaaaaaaaaaa", now: NOW - DAY_MS, timeZone: "UTC", from: "Routine", urgency: "emergency", message: "Water is leaking.", why: null, status: WAITING });
  const { dispatch } = noteStore({ [yesterday]: { etag: "y1", body: log } });
  const output = await notify({ now: NOW, timeZone: "UTC", onlyEmergencies: true }, { ctx: { notify: { dispatch, store: {} } } });
  assert.equal(output.to, "send");
  assert.equal(output.count, 1);
  assert.match(output.answer, /^Urgent, Routine: Water is leaking\.$/);
});

// --- structure --------------------------------------------------------------

test("no node imports a sibling node, so each runs on its own", () => {
  const files = readdirSync(NODES).filter((file) => file.endsWith(".js"));
  for (const mine of ["handback.js", "jobcheck.js", "mailadv.js", "notify.js"]) assert.ok(files.includes(mine), `${mine} is missing`);
  for (const file of files) {
    const text = readFileSync(new URL(file, NODES), "utf8");
    assert.doesNotMatch(text, /(?:from|import)\s*\(?\s*["']\.\/[^"']+["']/, `${file} imports a sibling`);
  }
});
