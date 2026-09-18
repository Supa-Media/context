/**
 * The agent turn, end to end through the real worker.
 *
 * A question goes in at `/agent`, the worker opens the customer's model account
 * through `/gateway/provider`, calls a **fake model** that answers with tool
 * calls, and those calls run through the same `callToolForSession` an MCP
 * client's do — against a real `S3Store` over the in-memory backend, behind the
 * real privacy engine.
 *
 * The fake model is scripted rather than clever: each test hands it a list of
 * replies and it returns them in order. That makes the assertions about the
 * *gateway* — which tools it offered, which it refused, what it sent to the
 * model and what it sent back — rather than about a model's judgement, which is
 * not a thing a test can pin.
 *
 * ## The two properties this file exists for
 *
 * **The agent has exactly the authority the connection has, and not one tool
 * more.** The turn does not assemble its own tool list or its own dispatcher;
 * it filters what `toolsForSession` returned and calls `callToolForSession`. A
 * private note must be invisible to an agent running on a `team`-tier grant,
 * for the same reason and by the same code as it is to that grant's client.
 *
 * **Writes are proposals.** `write_note` is never offered, however wide the
 * grant, and a model that asks for it anyway is refused by the tool layer
 * rather than by a list the model was shown.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `agentTools` returning `offered` unfiltered — the shape of "the agent
 *     gets what the client gets", which is the tempting simplification.
 *     → **2 fail**: `a write tool is never offered, however wide the grant` and
 *     `agentTools only ever narrows`.
 *
 *     The draft of this entry named the second one wrongly, as `the agent is
 *     offered the proposal tool and no other write` — which *passes* under this
 *     sabotage, because an unfiltered list still contains `propose_note`. A
 *     check that reads as though it covers a rule and passes when the rule is
 *     gone is worth knowing about: that one asserts the proposal tool is
 *     present and the *other* asserts nothing else is, and only together do
 *     they say what the sentence says.
 *  2. The route dispatching through the raw `callTool(name, args, store,
 *     "private")` instead of `callToolForSession(..., session)` — the agent
 *     reaching past the connection's clamp.
 *     → **1 fails**: `a private note stays invisible to a team-tier agent`.
 *     That check is the only one that can tell the two apart, which is exactly
 *     why it is here: everything else in this file passes with the clamp gone.
 *  3. `describePlace` interpolating `place.text` — the shape of "give the model
 *     the note it is looking at", added by somebody helping.
 *     → **2 fail**: `the ambient place carries references and never content`
 *     and `describePlace never reads a field that is not a reference`, one at
 *     the wire and one at the function.
 *  4. The turn recording `steps` with the arguments each tool was called with.
 *     → **1 fails**: `the steps name tools and never arguments`.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  createControlPlaneStub,
  createS3Backend,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
} from "./controlPlaneStub.mjs";
import { agentTools, describePlace, systemPrompt } from "../src/agent/turn.js";

const S3_ENDPOINT = "https://s3.example-agent.test";
const TOKEN_OWNER = `cat_agent_owner_${"0".repeat(24)}`;
const TOKEN_TEAM = `cat_agent_team_${"0".repeat(25)}`;
const TOKEN_READONLY = `cat_agent_read_${"0".repeat(25)}`;
const API_KEY = "zarquon-plumbago-agent-not-a-real-key-and-never-was";

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * A model that says what it was told to say.
 *
 * It also records every request it was sent, which is where the assertions
 * about the system prompt and the offered tools come from — asserting the wire
 * rather than the helper, so a turn that built the right prompt and then failed
 * to send it would still be caught.
 */
function createFakeModel() {
  const requests = [];
  let script = [];

  function install(replies) {
    script = [...replies];
  }

  async function handle(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ url, body, headers: init.headers ?? {} });
    const next = script.shift();
    if (!next) throw new Error("fake model: the script ran out");
    if (next.status && next.status !== 200) {
      return new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Anthropic's Messages shape, which is the provider these tests drive.
    const content = [];
    if (next.text) content.push({ type: "text", text: next.text });
    for (const call of next.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id ?? `toolu_${content.length}`,
        name: call.name,
        input: call.args ?? {},
      });
    }
    return new Response(
      JSON.stringify({
        content,
        stop_reason: (next.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return { requests, install, handle, origin: "https://api.anthropic.com" };
}

async function ask(env, tokenValue, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
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
  return { status: response.status, body: parsed, text };
}

export async function runAgentChecks(check) {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const model = createFakeModel();

  // The model server rides in front of both stubs: they each only claim their
  // own origin and pass everything else down the chain they captured.
  const withModel = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(model.origin)) return model.handle(url, init);
    return withModel(input, init);
  };

  try {
    controlPlane.addWorkspace("ws_agent", "alfa", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-agent",
      accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });

    await controlPlane.addGrant({
      accessToken: TOKEN_OWNER,
      workspaceId: "ws_agent",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_agent_owner",
      userId: "user_agent",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_TEAM,
      workspaceId: "ws_agent",
      role: "owner",
      // No `context:private`: a team-tier connection, the arrangement where a
      // private note must stay invisible.
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_agent_team",
      userId: "user_agent",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_READONLY,
      workspaceId: "ws_agent",
      role: "owner",
      scopes: ["context:read"],
      clientId: "mcp_client_agent_readonly",
      userId: "user_agent",
    });

    controlPlane.connectProvider("ws_agent", "anthropic", API_KEY);

    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

    // Seeded straight into the backend, the way the tenancy suite does it.
    // `4-archive` takes the manifest's `private` default; `1-projects` is
    // `team` — so one grant's tier really does decide which of the two an agent
    // can read, rather than both being reachable and the test proving nothing.
    const bucket = s3.bucketFor("tenant-agent");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "g0" });
    bucket.set("1-projects/pricing.md", {
      body: "# Pricing\n\nWe moved to $5 on 12 September.\n",
      etag: "g1",
    });
    bucket.set("4-archive/secret.md", { body: "PRIVATE-ONLY-MARKER\n", etag: "g2" });

    /* ---------------------- 1. an ordinary turn ---------------------------- */

    model.install([
      { toolCalls: [{ name: "search_notes", args: { query: "pricing" } }] },
      { toolCalls: [{ name: "read_note", args: { path: "1-projects/pricing.md" } }] },
      { text: "You moved to $5 on 12 September (1-projects/pricing.md)." },
    ]);
    const answered = await ask(env, TOKEN_OWNER, { question: "What did we do about pricing?" });

    check("a turn answers", answered.status === 200 && typeof answered.body?.answer === "string");
    check(
      "the answer is the model's last text",
      answered.body?.answer?.includes("12 September") === true,
    );
    check(
      "the turn names the provider it spent",
      answered.body?.provider === "anthropic",
    );
    check(
      "the steps name the tools that ran, in order",
      JSON.stringify(answered.body?.steps?.map((s) => s.tool)) ===
        JSON.stringify(["search_notes", "read_note"]),
    );
    check(
      "the steps name tools and never arguments",
      (answered.body?.steps ?? []).every(
        (step) => JSON.stringify(Object.keys(step).sort()) === JSON.stringify(["ok", "tool"]),
      ),
    );

    /* ---------------------- 2. the key, and where it goes ------------------ */

    check(
      "the key reaches the model provider and nothing else",
      model.requests.length > 0 &&
        model.requests.every((request) => request.headers["x-api-key"] === API_KEY),
    );
    check(
      "no answer the route gives carries the key",
      !JSON.stringify(answered.body).includes(API_KEY),
    );

    /* ---------------------- 3. the tools it is offered --------------------- */

    const offeredNames = (model.requests[0]?.body?.tools ?? []).map((tool) => tool.name);
    check(
      "a write tool is never offered, however wide the grant",
      !offeredNames.includes("write_note") &&
        !offeredNames.includes("move_note") &&
        !offeredNames.includes("set_visibility"),
    );
    check(
      "the agent is offered the proposal tool and no other write",
      offeredNames.includes("propose_note"),
    );
    check("the read tools are offered", offeredNames.includes("read_note"));

    /*
      A read-only grant gets an assistant that can answer and cannot suggest,
      because `toolsForSession` never offered it a write in the first place and
      `agentTools` only ever narrows.
    */
    model.install([{ text: "Nothing to suggest." }]);
    await ask(env, TOKEN_READONLY, { question: "anything?" });
    const readonlyTools = (model.requests[model.requests.length - 1].body.tools ?? []).map(
      (tool) => tool.name,
    );
    check(
      "a read-only connection's agent is not offered the proposal tool either",
      !readonlyTools.includes("propose_note") && readonlyTools.includes("read_note"),
    );

    /* ---------------------- 4. the clamp is the connection's --------------- */

    /*
      THE CHECK THIS FILE EXISTS FOR. A team-tier grant's agent asks for a
      private note by exact path. The refusal is the privacy engine's, reached
      through `callToolForSession` — not a list the model was shown, which it
      can always ignore.
    */
    model.install([
      { toolCalls: [{ name: "read_note", args: { path: "4-archive/secret.md" } }] },
      { text: "I could not read that one." },
    ]);
    await ask(env, TOKEN_TEAM, { question: "what is in the archive?" });
    const toolAnswer = model.requests[model.requests.length - 1].body.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === "tool_result")
      .map((block) => block.content)
      .join("\n");
    check(
      "a private note stays invisible to a team-tier agent",
      !toolAnswer.includes("PRIVATE-ONLY-MARKER"),
    );

    /* ---------------------- 5. the ambient place --------------------------- */

    model.install([{ text: "ok" }]);
    await ask(env, TOKEN_OWNER, {
      question: "what am I looking at?",
      place: {
        context: "alfa",
        note: { path: "1-projects/pricing.md", unsaved: true, readable: true },
        meetingLive: true,
        // Deliberately supplied, and it must not travel: an app that grew a
        // `text` field would otherwise hand a third-party model a note the
        // privacy clamp never saw.
        text: "PRIVATE-ONLY-MARKER",
      },
    });
    const sentSystem = model.requests[model.requests.length - 1].body.system ?? "";
    check(
      "the ambient place reaches the model",
      sentSystem.includes("1-projects/pricing.md") && sentSystem.includes("unsaved"),
    );
    check(
      "the ambient place carries references and never content",
      !sentSystem.includes("PRIVATE-ONLY-MARKER"),
    );
    check(
      "a live meeting is part of where the person is",
      sentSystem.includes("meeting"),
    );

    /* ---------------------- 6. refusals ------------------------------------ */

    const noQuestion = await ask(env, TOKEN_OWNER, { question: "   " });
    check("an empty question is refused", noQuestion.status === 400);

    const noProvider = await ask(env, TOKEN_OWNER, { question: "hi", provider: "ollama" });
    check(
      "a provider this build cannot spend is refused as an unconnected one",
      noProvider.status === 409 && noProvider.body?.error === "no_provider",
    );

    model.install([{ status: 500 }]);
    const modelDown = await ask(env, TOKEN_OWNER, { question: "hi" });
    check(
      "a provider that errored is opaque to the caller",
      modelDown.status === 502 &&
        modelDown.body?.error === "model_unavailable" &&
        JSON.stringify(modelDown.body) === JSON.stringify({ error: "model_unavailable" }),
    );

    const unauthenticated = await ask(env, "cat_not_a_token_000000000000000000", {
      question: "hi",
    });
    check("an unknown token reaches no turn", unauthenticated.status === 401);

    /* ---------------------- 7. the helpers, directly ----------------------- */

    check(
      "describePlace never reads a field that is not a reference",
      describePlace({ note: { path: "a.md" }, text: "SECRET", body: "SECRET" }).includes(
        "SECRET",
      ) === false,
    );
    check(
      "the system prompt tells the model it cannot edit",
      systemPrompt(null).includes("propose_note"),
    );
    check(
      "agentTools only ever narrows",
      agentTools([
        { name: "read_note", annotations: { readOnlyHint: true } },
        { name: "write_note", annotations: { readOnlyHint: false } },
        { name: "propose_note", annotations: { readOnlyHint: false } },
      ]).map((tool) => tool.name).join(",") === "read_note,propose_note",
    );
    check(
      "agentTools cannot invent a tool that was not offered",
      agentTools([{ name: "read_note", annotations: { readOnlyHint: true } }]).length === 1,
    );

    /*
      A length bound, not a trust boundary: the app that builds the place is the
      person's own client. What it buys is that a client bug which puts a whole
      document where a path goes costs one confused answer rather than a bill,
      on a request the customer pays for by the token.
    */
    check(
      "an absurdly long place field is dropped rather than sent",
      describePlace({ context: "a".repeat(5000), note: { path: "b".repeat(5000) } }) === "",
    );
    check(
      "an ordinary place field still arrives",
      describePlace({ note: { path: "1-projects/pricing.md" } }).includes(
        "1-projects/pricing.md",
      ),
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
