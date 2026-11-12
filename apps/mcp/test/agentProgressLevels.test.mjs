/**
 * PROGRESS UPDATES, LEVEL BY LEVEL (part B of the owner's decisions, Dev2,
 * 2026-11-01): what the model is told at each level, and what reaches the chat.
 *
 * - off: no tool, nothing said of progress, yet a browser sign-in link the
 *   gateway writes still goes as its own line;
 * - plan only: the level said up front, one plan line, the rest refused;
 * - normal: the level said up front, a plan line, then lines that earn their text.
 *
 * Each runs the texted route as the texting Worker calls it (a stream), with a
 * scripted model: a plan line, a browser handed to the person to sign in, a
 * second line, the answer.
 *
 * Sabotage (temporary local edits, reverted):
 *  - route.js building the channel only when updates are not off: "off" fails (the link goes in the reply, not as a line);
 *  - turnPrompt.js always saying PROGRESS_PROMPT: "plan only" fails (the level is not said);
 *  - progress.js PLAN_EXAMPLE starting "I'll check": "the plan example passes the done check" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { resetBrowserbaseProbe } from "../src/agent/browserProviders.js";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { NORMAL_LEAD, PLAN_EXAMPLE, PLAN_ONLY_LEAD, PLAN_ONLY_NOTICE, claimsDone } from "../src/agent/progress.js";

const S3_ENDPOINT = "https://s3.example-levels.test";
const TOKEN_TEXTS = `cat_levels_texts_${"0".repeat(22)}`;
const PLAN = "Checking shop.example.com for your order, then your cart.";
const SECOND = "Now reading your cart.";
const ANSWER = "Your cart has socks for $5.";

function call(name, args) {
  return { name, args };
}

/** One streamed texted turn at `updates`; returns what the model was told and the chat's bubbles. */
async function turnAt(updates) {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  try {
    controlPlane.addWorkspace("ws_levels", "levels", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-levels",
      accessKeyId: "AKIAEXAMPLEEXAMPLEAB",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAB",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_TEXTS,
      workspaceId: "ws_levels",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "context_texts",
      userId: "user_levels",
    });
    controlPlane.setBuiltinVerdict("ws_levels", { allowed: true, remaining: 50 });
    resetBrowserbaseProbe();
    const SITE_SHOTS = {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        if (new URL(url).pathname === "/browse/close") return Response.json({ closed: true });
        return Response.json({
          session: "bb-levels-1",
          ran: body.steps.map((s) => ({ do: s.do, ok: true })),
          page: { url: "https://shop.example.com/login", title: "Sign in", text: "Sign in", truncated: false, elements: [] },
        });
      },
    };
    const script = [
      call("text_progress", { text: PLAN }),
      call("browse", { steps: [{ do: "goto", url: "https://shop.example.com/" }, { do: "handoff" }] }),
      call("text_progress", { text: SECOND }),
      null,
    ];
    const calls = [];
    const AI = {
      async run(model, input) {
        if (model.includes("clef") || input?.questions) return { answers: {} };
        calls.push(input);
        const next = script.shift();
        return {
          choices: [{ message: { content: next ? "" : ANSWER, tool_calls: next ? [{ id: `c${calls.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] : [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
    };
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, AI, SITE_SHOTS, APP_ORIGIN: "https://app.context.test" };
    const { ctx, settle } = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://mcp.context.test/agent", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ question: "Log me in to shop.example.com and check my cart", ...(updates ? { updates } : {}) }),
      }),
      env,
      ctx,
    );
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    await settle();
    return {
      told: calls[0]?.messages?.[0]?.content ?? "",
      tools: JSON.stringify(calls[0]?.tools ?? []),
      later: JSON.stringify(calls.slice(1)),
      bubbles: lines.filter((line) => typeof line.progress === "string").map((line) => line.progress),
      answer: lines.at(-1)?.body?.answer ?? "",
    };
  } finally {
    resetBrowserbaseProbe();
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}

const LINK = "https://app.context.test/tex/@levels";

test("off: nothing said of progress and no tool, yet the sign-in link still goes as its own line", async () => {
  const { told, tools, bubbles, answer } = await turnAt("off");
  assert.doesNotMatch(told, /send with action progress|progress lines|plan line/);
  assert.doesNotMatch(tools, /text_progress|Text the person one short line/);
  assert.equal(bubbles.length, 1, JSON.stringify(bubbles));
  assert.ok(bubbles[0].includes(LINK), "the gateway's link line");
  assert.ok(!answer.includes(LINK), "not left for the reply");
  assert.ok(answer.startsWith(ANSWER));
});

test("plan only: the level said up front, the plan line and the link go, the second line is refused", async () => {
  const { told, bubbles, later } = await turnAt("planOnly");
  assert.ok(told.includes(PLAN_ONLY_LEAD), "the level is said");
  assert.ok(!told.includes(NORMAL_LEAD));
  assert.equal(bubbles[0], PLAN);
  assert.ok(bubbles[1].includes(LINK));
  assert.equal(bubbles.length, 2, JSON.stringify(bubbles));
  assert.ok(later.includes(PLAN_ONLY_NOTICE.slice(0, 40)), "the model is told why the second line did not go");
});

test("normal: the level said up front, the plan line, the link and the next line go in order", async () => {
  const { told, bubbles } = await turnAt(undefined);
  assert.ok(told.includes(NORMAL_LEAD));
  assert.ok(!told.includes(PLAN_ONLY_LEAD));
  assert.match(told, /more than about a minute/);
  assert.match(told, /fewer the longer it runs/);
  assert.deepEqual([bubbles[0], bubbles[2]], [PLAN, SECOND]);
  assert.ok(bubbles[1].includes(LINK));
  assert.equal(bubbles.length, 3);
});

test("the plan example passes the done check, so the model's copy of it is never refused", () => {
  assert.equal(claimsDone(PLAN_EXAMPLE), false);
  assert.equal(claimsDone(PLAN), false);
});

// Nov Babies, 2026-11-12: a job was told "Sent" for lines the texting Worker only puts on its status (`jobRun.ts`).
test("a job's line with no link is noted on its status, not reported as texted; one with a link is sent", async () => {
  const { progressChannel: channelOf, JOB_NOTED } = await import("../src/agent/progress.js");
  const said = [];
  const channel = channelOf(async (text) => said.push(text), { job: true });
  const plain = await channel.call({ text: "Checking each venue's own page." });
  assert.equal(plain.content[0].text, JOB_NOTED);
  const linked = await channel.call({ text: "Sign in here: https://example.test/login" });
  assert.equal(linked.content[0].text, "Sent. Keep working.");
  assert.deepEqual(said, ["Checking each venue's own page.", "Sign in here: https://example.test/login"]);
  const texted = await channelOf(async () => {}).call({ text: "Opening OpenTable for Friday." });
  assert.equal(texted.content[0].text, "Sent. Keep working.");
});
