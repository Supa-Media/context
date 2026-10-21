/**
 * BACKGROUND JOBS, END TO END THROUGH `/agent` (`background.js`).
 *
 * A text from the texting Worker, which sends what the chat has running,
 * starts a job and is answered at once; the job's own turn runs on the
 * person's words with the plan it started with, can't start another, and is
 * kept in the conversation by name. Unit checks: `agentBackground.test.mjs`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `chatTurn` true for every client.
 *     → "only a texted turn is offered background jobs" fails.
 *  2. `jobSavedLine` dropped from the saved line.
 *     → "the job's exchange is kept by name, not as their ask again" fails.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { conversationTurns } from "./agentConversationFixture.mjs";

const S3_ENDPOINT = "https://s3.example-background.test";
const TOKEN_TEXTS = `cat_backgr_texts_${"0".repeat(23)}`;
const TOKEN_APP = `cat_backgr_app_${"0".repeat(25)}`;

function fakeModel() {
  const requests = [];
  let script = [];
  return {
    requests,
    install(replies) {
      script = [...replies];
    },
    async handle(_url, init) {
      requests.push(JSON.parse(init.body));
      const next = script.shift();
      if (!next) throw new Error("fake model: the script ran out");
      const content = next.text ? [{ type: "text", text: next.text }] : [];
      for (const [i, call] of (next.toolCalls ?? []).entries()) {
        content.push({ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.args ?? {} });
      }
      return new Response(
        JSON.stringify({ content, stop_reason: (next.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}

async function post(env, token, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

const tool = async (env, token, name, args) =>
  (await post(env, token, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body?.result;

const sendTool = (request) => (request?.tools ?? []).find((entry) => entry.name === "send");
const toolReplies = (request) =>
  (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content ?? ""));
const userText = (request) => {
  const first = request?.messages?.[0]?.content;
  return typeof first === "string" ? first : JSON.stringify(first ?? "");
};


const systemOf = (request) =>
  Array.isArray(request?.system) ? request.system.map((block) => block?.text ?? "").join("\n") : String(request?.system ?? "");

export async function runAgentBackgroundRouteChecks(check) {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const model = fakeModel();
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) return model.handle(url, init);
    return withStubs(input, init);
  };

  try {
    controlPlane.addWorkspace("ws_maya", "maya", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-background",
      accessKeyId: "AKIAEXAMPLEEXAMPLEBG",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBG",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const scopes = ["context:read", "context:write", "context:private"];
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({ accessToken, workspaceId: "ws_maya", role: "owner", scopes, clientId, userId: "user_maya" });
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_APP, "context_console");
    controlPlane.setBuiltinVerdict("ws_maya", BUILTIN_ALLOWED);
    const bucket = s3.bucketFor("tenant-background");
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });

    /* ---------------- a text starts a job and is answered at once ---------------- */

    const running = [{ id: "job-trip-plan-1", title: "Trip plan", state: "running", startedAt: Date.now() - 5 * 60_000, status: "Comparing hotels" }];
    model.install([
      { toolCalls: [{ name: "send", args: { action: "background", args: { title: "Competitor research", brief: "Five competitors, into 1-projects/tex.", done_when: "a note" } } }] },
      { text: "On it. I'll text you when it's done." },
    ]);
    const started = await post(env, TOKEN_TEXTS, "/agent", { question: "research our competitors and write it up", conversation: "texts", running });
    const first = model.requests[0];
    check("a text from a Worker that runs jobs is offered background, under send", /background: Hand a long task/.test(sendTool(first)?.description ?? ""));
    check(
      "the turn is shown what's running, with its status",
      /"Trip plan": running, started 5 min ago; latest: Comparing hotels/.test(systemOf(first)),
    );
    check(
      "the answer names the job for the Worker to run",
      started.status === 200 &&
        started.body?.jobs?.length === 1 &&
        started.body.jobs[0].title === "Competitor research" &&
        started.body.jobs[0].brief === "Five competitors, into 1-projects/tex." &&
        started.body.jobs[0].tainted === undefined,
    );

    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_TEXTS, "/agent", { question: "hello", conversation: "texts" });
    check("a Worker that sends no running list is offered no background jobs", !/background:/.test(sendTool(model.requests.at(-1))?.description ?? ""));
    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_APP, "/agent", { question: "hello", running: [] });
    check("only a texted turn is offered background jobs", !/background:/.test(sendTool(model.requests.at(-1))?.description ?? ""));

    /* ---------------- the job's own turn ---------------- */

    model.install([{ text: "Wrote 1-projects/tex/competitors.md: Notion, Mem, Reflect." }]);
    const job = { id: "job-competitors-1", title: "Competitor research", brief: "Five competitors, into 1-projects/tex.", attempt: 2 };
    const ran = await post(env, TOKEN_TEXTS, "/agent", { question: "research our competitors and write it up", conversation: "texts", job });
    const jobRequest = model.requests.at(-1);
    check("a job's own turn is told its plan and to deliver", /background job you started/.test(systemOf(jobRequest)) && /Five competitors, into 1-projects\/tex\./.test(systemOf(jobRequest)) && /carry on from where it stops/.test(systemOf(jobRequest)));
    check("a job's own turn cannot start another job", !/background:/.test(sendTool(jobRequest)?.description ?? ""));
    const turns = conversationTurns(bucket);
    check(
      "the job's exchange is kept by name, not as their ask again",
      ran.status === 200 && turns.at(-2)?.text === "(Background job finished: Competitor research)" && /Notion, Mem, Reflect/.test(turns.at(-1)?.text ?? ""),
    );
    check("a job's turn names no jobs of its own", ran.body?.jobs === undefined);
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
