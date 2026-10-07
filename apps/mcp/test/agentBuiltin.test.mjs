/**
 * THE BUILT-IN MODEL, END TO END THROUGH `/agent`.
 *
 * "Premium, capped" (decided by the owner, 2026-10-06): with no model account
 * of the person's own, `/agent` asks the control plane whether this turn may
 * spend ours, runs it on the Workers AI binding, and reports token counts back.
 * The control plane's side of the decision is `apps/convex/__tests__/
 * builtinModel.test.ts`; these checks are the gateway's half:
 *
 *  - a connected key always wins over ours;
 *  - no verdict, no binding, or a refusal means no call to Workers AI at all;
 *  - the caller can never pick which model we pay for;
 *  - what goes back to the meter is counts, never text.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  createControlPlaneStub,
  createS3Backend,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
} from "./controlPlaneStub.mjs";
import { DEFAULT_BUILTIN_MODEL, requestBuiltin } from "../src/agent/builtin.js";

const S3_ENDPOINT = "https://s3.example-builtin.test";
const TOKEN = `cat_builtin_texter_${"0".repeat(21)}`;
const TOKEN_KEYED = `cat_builtin_keyed_${"0".repeat(22)}`;
const API_KEY = "zarquon-plumbago-builtin-not-a-real-key";

/** A Workers AI binding that answers from a script and records what it was sent. */
function fakeAi() {
  const calls = [];
  let script = [];
  return {
    calls,
    install(replies) {
      script = [...replies];
    },
    async run(model, input) {
      calls.push({ model, input });
      const next = script.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      if (next.throws) throw new Error(`upstream said: ${JSON.stringify(input.messages)}`);
      return next;
    },
  };
}

function chat(text, toolCalls = [], usage = { prompt_tokens: 100, completion_tokens: 10 }) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: toolCalls.map((call, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage,
  };
}

async function ask(env, token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

export async function runAgentBuiltinChecks(check) {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const keyedModelCalls = [];
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.anthropic.com")) {
      keyedModelCalls.push(url);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "from your key" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return withStubs(input, init);
  };

  try {
    for (const [id, slug, bucket] of [
      ["ws_texter", "texter", "tenant-texter"],
      ["ws_keyed", "keyed", "tenant-keyed"],
    ]) {
      controlPlane.addWorkspace(id, slug, {
        provider: "s3",
        status: "active",
        endpoint: S3_ENDPOINT,
        region: "auto",
        bucket,
        accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
        forcePathStyle: true,
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      });
    }
    await controlPlane.addGrant({
      accessToken: TOKEN,
      workspaceId: "ws_texter",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "context_texts",
      userId: "user_texter",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_KEYED,
      workspaceId: "ws_keyed",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "context_texts",
      userId: "user_keyed",
    });
    controlPlane.connectProvider("ws_keyed", "anthropic", API_KEY);
    s3.bucketFor("tenant-texter").set("1-projects/launch.md", { body: "# Launch\n\nFriday.\n", etag: "g1" });

    const ai = fakeAi();
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, AI: ai };

    /* ---------------- refused before anything is spent ---------------- */

    const free = await ask(env, TOKEN, { question: "When is the launch?" });
    check(
      "a workspace the control plane refuses is told to connect an account, and Workers AI is never called",
      free.status === 409 && free.body?.error === "no_provider" && ai.calls.length === 0,
    );

    controlPlane.setBuiltinVerdict("ws_texter", { allowed: false, reason: "daily_cap" });
    const capped = await ask(env, TOKEN, { question: "When is the launch?" });
    check(
      "over the daily cap is its own answer, and Workers AI is never called",
      capped.status === 429 && capped.body?.error === "daily_limit" && ai.calls.length === 0,
    );

    controlPlane.setBuiltinVerdict("ws_texter", { allowed: true, remaining: 10 });
    const unbound = await ask({ ...env, AI: undefined }, TOKEN, { question: "When is the launch?" });
    check(
      "a gateway with no Workers AI binding has no built-in model",
      unbound.status === 409 && unbound.body?.error === "no_provider",
    );

    /* ---------------- an allowed turn ---------------- */

    ai.install([
      chat("", [{ name: "read_note", args: { path: "1-projects/launch.md" } }], { prompt_tokens: 300, completion_tokens: 20 }),
      chat("The launch is on Friday.", [], { prompt_tokens: 400, completion_tokens: 12 }),
    ]);
    const answered = await ask(env, TOKEN, { question: "When is the launch?", model: "@cf/some/expensive-model" });
    check(
      "an allowed turn is answered by the built-in model, tools and all",
      answered.status === 200 &&
        answered.body?.answer === "The launch is on Friday." &&
        answered.body?.provider === "builtin" &&
        JSON.stringify(ai.calls[1]?.input?.messages ?? []).includes("Friday."),
    );
    check(
      "the caller cannot choose the model we pay for",
      ai.calls.length === 2 && ai.calls.every((call) => call.model === DEFAULT_BUILTIN_MODEL),
    );
    const system = String(ai.calls[0]?.input?.messages?.[0]?.content ?? "");
    check(
      "a texting grant's turn is told it is writing a text, with no Markdown and no note paths",
      ai.calls[0]?.input?.messages?.[0]?.role === "system" &&
        system.includes("No Markdown") &&
        system.includes("Don't name note paths") &&
        !system.includes("Cite the note path"),
    );
    const report = controlPlane.builtinReports.at(-1);
    check(
      "the turn's own token counts go back to the meter, and nothing else",
      report?.inputTokens === 700 &&
        report?.outputTokens === 32 &&
        report?.failed === false &&
        !JSON.stringify(report).includes("launch") &&
        !JSON.stringify(report).includes("Friday"),
    );

    ai.install([{ throws: true }]);
    const broken = await ask(env, TOKEN, { question: "When is the launch?" });
    check(
      "a failed built-in turn is opaque to the caller and reported as failed",
      broken.status === 502 &&
        JSON.stringify(broken.body) === JSON.stringify({ error: "model_unavailable" }) &&
        controlPlane.builtinReports.at(-1)?.failed === true,
    );

    /* ---------------- a connected key always wins ---------------- */

    controlPlane.setBuiltinVerdict("ws_keyed", { allowed: true, remaining: 10 });
    const before = ai.calls.length;
    const keyed = await ask(env, TOKEN_KEYED, { question: "When is the launch?" });
    check(
      "a person's own connected key is used before ours",
      keyed.status === 200 &&
        keyed.body?.provider === "anthropic" &&
        keyedModelCalls.length === 1 &&
        ai.calls.length === before,
    );

    /* ---------------- the adapter, directly ---------------- */

    const legacy = await requestBuiltin(
      { model: DEFAULT_BUILTIN_MODEL, system: "s", messages: [{ role: "user", text: "q" }], tools: [] },
      { run: async () => ({ response: "", tool_calls: [{ name: "search", arguments: { query: "x" } }] }) },
    );
    check(
      "the older Workers AI answer shape is read too, with parsed arguments kept",
      legacy.toolCalls.length === 1 && legacy.toolCalls[0].args.query === "x" && legacy.usage.input === 0,
    );
    let thrown = null;
    try {
      await requestBuiltin(
        { model: DEFAULT_BUILTIN_MODEL, system: "s", messages: [{ role: "user", text: "SECRET-QUESTION" }], tools: [] },
        { run: async (_m, input) => { throw new Error(JSON.stringify(input)); } },
      );
    } catch (error) {
      thrown = error;
    }
    check(
      "a Workers AI error never carries the request into the gateway's errors",
      thrown !== null && !String(thrown.message).includes("SECRET-QUESTION") && !String(thrown.stack).includes("SECRET-QUESTION"),
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
