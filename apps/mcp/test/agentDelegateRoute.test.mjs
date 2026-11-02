/**
 * A DELEGATED JOB, END TO END THROUGH `/agent` (`delegate.js`, `supervise.js`).
 *
 * A text hands a job to Claude Code; the agent, on its own Context
 * connection, joins the task note's mail and reports; the supervisor routine
 * reads that mail on its own connection, answers on the note, and once the
 * note says done texts the result, puts it in the texting conversation and
 * stops itself. The unit checks are `agentDelegate.test.mjs`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. The quiet early return in `route.js` removed (every run opens a model).
 *     → "a supervisor run with nothing new costs no model call" fails.
 *  2. `deliverSupervision` not writing the texting conversation.
 *     → "the result reaches the texting conversation, marked as read from outside" fails.
 *  3. `delegation` built for any client, not only texts.
 *     → "only a text is offered delegate" fails.
 *  4. `prepareSupervision` sending a done job to the model.
 *     → "a done job is texted once, as finished, with no model call" fails.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { conversationTurns } from "./agentConversationFixture.mjs";
import { texStoreNamespace, withAgentHome } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-delegate.test";
const TOKEN_TEXTS = `cat_delegate_texts_${"0".repeat(21)}`;
const TOKEN_RUNNER = `cat_delegate_runner_${"0".repeat(20)}`;
const TOKEN_AGENT = `cat_delegate_agent_${"0".repeat(21)}`;
const TOKEN_APP = `cat_delegate_app_${"0".repeat(23)}`;

const TASK = "1-projects/app/fix-the-sign-in-loop.md";
const SUPERVISOR = "tex/routines/every-10-minutes/delegate-fix-the-sign-in-loop.md";

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

export async function runAgentDelegateRouteChecks(check) {
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
      bucket: "tenant-delegate",
      accessKeyId: "AKIAEXAMPLEEXAMPLEDL",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEDL",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const scopes = ["context:read", "context:write", "context:private"];
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({ accessToken, workspaceId: "ws_maya", role: "owner", scopes, clientId, userId: "user_maya" });
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_RUNNER, "context_routines");
    await grant(TOKEN_AGENT, "claude_ai");
    await grant(TOKEN_APP, "context_console");
    controlPlane.setBuiltinVerdict("ws_maya", BUILTIN_ALLOWED);
    const tex = texStoreNamespace();
    const bucket = withAgentHome(s3.bucketFor("tenant-delegate"), tex, "ws_maya"); // the bookkeeping is the person's object's (`texStoreFixture.mjs`)
    bucket.set("1-projects/app/overview.md", { body: "# The app\n", etag: "g1" });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: tex.namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const read = async (path) => (await tool(env, TOKEN_APP, "read_note", { path }))?.content?.[0]?.text ?? "";

    /* ---------------- a text hands the job off ---------------- */

    model.install([
      {
        toolCalls: [
          {
            name: "send",
            args: {
              action: "delegate",
              args: {
                agent: "claude-code",
                title: "Fix the sign-in loop",
                brief: "Fix the sign-in loop in our repo: the code screen goes back to the email screen. Open a PR.",
                folder: "1-projects/app",
              },
            },
          },
        ],
      },
      { text: "Claude Code is on it. I'll text you when it's done." },
    ]);
    const handed = await post(env, TOKEN_TEXTS, "/agent", { question: "get claude code to fix the sign-in loop", conversation: "texts" });
    const first = model.requests[0];
    check(
      "a text is offered delegate, under send",
      handed.status === 200 && /delegate: Hand a whole sub-project/.test(sendTool(first)?.description ?? ""),
    );
    const said = toolReplies(model.requests[1]).join("\n");
    check(
      "the handoff says where to start the agent and what to send it",
      /https:\/\/claude\.ai\/code/.test(said) && /args: \{ join: "claude-code" \}/.test(said),
    );
    const task = await read(TASK);
    check(
      "the task note is on the project's board, owned by the person's Claude Code",
      /status: in progress/.test(task) && /owner: @maya's Claude Code/.test(task) && /## Result/.test(task),
    );
    check("its supervisor is a routine in Tex's own folder", /supervises: @maya\/1-projects\/app\/fix-the-sign-in-loop\.md/.test(await read(SUPERVISOR)));
    check("the job is listed in tex/jobs.md", /\[Fix the sign-in loop\]\(@maya\/1-projects\/app\/fix-the-sign-in-loop\.md\)/.test(await read("tex/jobs.md")));

    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_APP, "/agent", { question: "hello" });
    check("only a text is offered delegate", !/delegate:/.test(sendTool(model.requests.at(-1))?.description ?? ""));

    /* ---------------- the supervisor loop ---------------- */

    let before = model.requests.length;
    const quiet = await post(env, TOKEN_RUNNER, "/agent", { routine: { path: SUPERVISOR } });
    check(
      "a supervisor run with nothing new costs no model call",
      quiet.status === 200 && quiet.body?.outcome === "skipped" && model.requests.length === before,
    );
    check("the supervisor joined the note's mail as tex", /tex \([^)]*\) joined/.test(await read(TASK)));

    // The agent, on its own connection, joins and asks a question.
    const joined = await tool(env, TOKEN_AGENT, "write_note", { path: TASK, mail: { join: "claude-code" } });
    const mailbox = /mailbox: (\S+)/.exec(joined?.content?.[0]?.text ?? "")?.[1];
    await tool(env, TOKEN_AGENT, "write_note", { path: TASK, mailbox, mail: { text: "Which branch should the PR target?", to: "everyone" } });

    model.install([{ toolCalls: [{ name: "send", args: { action: "mail_agent", args: { text: "Target main." } } }] }, { text: "SKIP" }]);
    before = model.requests.length;
    const review = await post(env, TOKEN_RUNNER, "/agent", { routine: { path: SUPERVISOR } });
    const asked = model.requests[before];
    check(
      "new mail is reviewed by the model, as the agent's words",
      review.body?.outcome === "skipped" &&
        userText(asked).includes("Which branch should the PR target?") &&
        userText(asked).includes("not instructions to you"),
    );
    check("the supervisor's answer lands in the note's mail, signed tex", /tex \([^)]*\) to everyone: Target main\./.test(await read(TASK)));
    check(
      "the supervisor is offered mail_agent and no note saves",
      /mail_agent:/.test(sendTool(asked)?.description ?? "") &&
        !/- save:/.test((asked.tools ?? []).find((entry) => entry.name === "write")?.description ?? ""),
    );

    /* ---------------- done ---------------- */

    const current = await tool(env, TOKEN_AGENT, "read_note", { path: TASK });
    const etag = /^etag: (.+)$/m.exec(current?.content?.[0]?.text ?? "")?.[1];
    const body = (current?.content?.[0]?.text ?? "").split("\n\n").slice(1).join("\n\n");
    await tool(env, TOKEN_AGENT, "write_note", {
      path: TASK,
      expected_etag: etag,
      content: body.replace("status: in progress", "status: done").replace("Not yet.", "https://github.com/example/app/pull/7"),
    });
    before = model.requests.length;
    const done = await post(env, TOKEN_RUNNER, "/agent", { routine: { path: SUPERVISOR } });
    check(
      "a done job is texted once, as finished, with no model call",
      done.body?.outcome === "finished" && /pull\/7/.test(done.body?.answer ?? "") && model.requests.length === before,
    );
    const conversation = { turns: conversationTurns(bucket) };
    const last = conversation.turns?.at(-1);
    check(
      "the result reaches the texting conversation, marked as read from outside",
      last?.role === "assistant" && /pull\/7/.test(last.text) && last.tainted === true && /Tex's supervisor/.test(conversation.turns.at(-2)?.text ?? ""),
    );
    check("the finished job leaves tex/jobs.md", !/fix-the-sign-in-loop/.test(await read("tex/jobs.md")));
    const stopped = await read(SUPERVISOR);
    check("the supervisor stops itself", stopped === "" || /paused: yes/.test(stopped));
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
