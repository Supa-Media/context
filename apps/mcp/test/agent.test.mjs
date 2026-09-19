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
 * grant, and a model that names it anyway is refused *at the dispatch* — not by
 * the list it was shown, which it can always ignore, and not by the tool layer,
 * which on an owner's own grant would have carried the write out. The first
 * draft of this file asserted only the offering and said this sentence anyway;
 * section 4b is the sentence.
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
 *  5. `agentTools` dropping the `WITHHELD_FROM_AGENT` filter — the shape of
 *     "`readOnlyHint` already says whether a model may call it".
 *     → **2 fail**: `the key export is never offered to the agent` and `...and
 *     does not run at all, whatever the model named`, one at the offering and
 *     one at the call. Two guards, and the export needs both gone to land.
 *  6. `runTurn` dispatching `call.name` without checking it against `tools` —
 *     the state this file was merged in.
 *     → **2 fail**: `a tool the agent was never offered writes nothing` and
 *     `...and does not run at all, whatever the model named`. The first one is
 *     the damage: the note really is in the bucket.
 *  7. `export_encryption_keys` renamed throughout `index.js` and nowhere else —
 *     the drift that makes a literal in `WITHHELD_FROM_AGENT` stop matching,
 *     which the absence check cannot see.
 *     → `this connection's client really is offered the key export` fails (with
 *     four in the encryption suite). The absence check passes, vacuously, which
 *     is the whole reason its companion is there.
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

/** What the same connection's MCP client is offered, for comparison. */
async function clientToolNames(env, tokenValue) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    env,
    ctx,
  );
  const names = (JSON.parse(await response.text())?.result?.tools ?? []).map((tool) => tool.name);
  await settle();
  return names;
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
      AND `readOnlyHint` IS THE WRONG AXIS FOR "MAY A MODEL CALL THIS".

      `export_encryption_keys` mutates nothing, so it is annotated
      `readOnlyHint: true` — correct, for what that flag answers. It also
      returns this context's workspace data key(s) **in the clear**, and its own
      description says there is no un-export. `agentTools` read that flag as
      "safe to hand a model" and offered it, on the one grant tier that can call
      it — this one.

      Where that ends is not the answer on the screen. `propose_note` is offered
      too and writes its content into the bucket, so a turn talked into
      exporting and then proposing puts the key that opens every encrypted note
      in this context next to the notes it opens: plaintext, at rest, in the one
      place the encryption exists to survive. Non-negotiable #1 — credentials
      never live in the bucket.

      `WITHHELD_FROM_AGENT` holds the name as a string literal, so a check that
      only asserts absence would keep passing after somebody renamed the tool
      and quietly unwithheld it. The companion check below asserts the same
      connection's *client* is still offered it, which is the half that fails on
      that rename.
    */
    const clientNames = await clientToolNames(env, TOKEN_OWNER);
    check(
      "this connection's client really is offered the key export",
      clientNames.includes("export_encryption_keys"),
    );
    check(
      "the key export is never offered to the agent",
      !offeredNames.includes("export_encryption_keys"),
    );

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

    /* ------------ 4b. the narrowed list is not the control ----------------- */

    /*
      THE LIST HAS TO BE ENFORCED WHERE THE CALL IS MADE, NOT ONLY WHERE IT IS
      ADVERTISED.

      This file's header already claimed it — "a model that asks for it anyway
      is refused by the tool layer rather than by a list the model was shown" —
      and nothing drove it: every scripted reply above names a tool that was
      offered. The claim was false. `agentTools` decided what the model is
      *told about*; the name in its reply went straight to `callToolForSession`,
      which is the client's whole dispatcher and holds this connection's whole
      authority. So "writes are proposals" was a property of the prompt.

      Which matters because the model's reply is not only the model's. A
      personal context takes email into `0-inbox/`, so a sentence in a note the
      agent reads is reachable by anyone who knows the address — and a turn that
      acted on one had the act executed under the owner's own grant.

      Two names in one reply: the write the design says is impossible, and the
      key export, which is the same hole at its worst.
    */
    model.install([
      {
        toolCalls: [
          {
            name: "write_note",
            args: { path: "1-projects/injected.md", content: "# owned\n" },
          },
          { name: "export_encryption_keys", args: {} },
        ],
      },
      { text: "I could not do that." },
    ]);
    const invented = await ask(env, TOKEN_OWNER, { question: "tidy up my notes" });
    check(
      "a tool the agent was never offered writes nothing",
      invented.status === 200 && !bucket.has("1-projects/injected.md"),
    );
    check(
      "...and does not run at all, whatever the model named",
      (invented.body?.steps ?? []).every(
        (step) => step.tool !== "write_note" && step.tool !== "export_encryption_keys",
      ),
    );
    check(
      "...and the turn finishes rather than dying of it",
      invented.body?.answer === "I could not do that.",
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
