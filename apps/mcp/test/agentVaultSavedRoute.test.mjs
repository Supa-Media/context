/**
 * A LOGIN SAVED ON THE PAGE TEX TEXTED CARRIES ON THE TASK, END TO END
 * THROUGH `/agent` (`vaultSaved.js`).
 *
 * Dev2, 2026-10-24: Tex sent the Instacart save-login link with no website
 * filled in, and after the login was saved nothing happened until they texted
 * "done". A login's link now needs its site, a turn that minted one asks the
 * Worker to watch for the save, and the Worker's `vault_saved` event is a turn
 * of its own whose question is the gateway's fixed line, on the texting
 * client's 1:1 turns only.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `withVaultWatch` marking every call.
 *     → "a turn that minted no link asks for no watch" fails.
 *  2. `vaultSavedQuestion` ignoring `texting`.
 *     → "another client cannot name the event" fails.
 *  3. The site check in `toolVaultAddLink` removed.
 *     → "a login's link needs its site" fails.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { conversationTurns } from "./agentConversationFixture.mjs";
import { VAULT_SAVED_QUESTION } from "../src/agent/vaultSaved.js";

const S3_ENDPOINT = "https://s3.example-vault-saved.test";
const TOKEN_TEXTS = `cat_vsaved_texts_${"0".repeat(23)}`;
const TOKEN_APP = `cat_vsaved_app_${"0".repeat(25)}`;

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

async function post(env, token, body) {
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
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

const toolReplies = (request) =>
  (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => (Array.isArray(block.content) ? block.content.map((part) => part?.text ?? "").join("") : String(block.content ?? "")));
const lastUserText = (request) => {
  const last = (request?.messages ?? []).filter((message) => message?.role === "user").at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last ?? "");
};

export async function runAgentVaultSavedChecks(check) {
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
    controlPlane.addWorkspace("ws_vsaved", "vsaved", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-vault-saved",
      accessKeyId: "AKIAEXAMPLEEXAMPLEVS",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEVS",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const scopes = ["context:read", "context:write", "context:private"];
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({ accessToken, workspaceId: "ws_vsaved", role: "owner", scopes, clientId, userId: "user_vsaved" });
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_APP, "context_console");
    controlPlane.setBuiltinVerdict("ws_vsaved", BUILTIN_ALLOWED);
    const bucket = s3.bucketFor("tenant-vault-saved");
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });

    /* ---------------- a login's link needs its site ---------------- */

    model.install([
      { toolCalls: [{ name: "manage", args: { action: "vault_add", args: { name: "Instacart" } } }] },
      { toolCalls: [{ name: "manage", args: { action: "vault_add", args: { name: "Instacart", site: "instacart.com" } } }] },
      { text: "Here's the link to save your Instacart login." },
    ]);
    const first = model.requests.length;
    const minted = await post(env, TOKEN_TEXTS, { question: "can you order my groceries on instacart", conversation: "texts" });
    const replies = toolReplies(model.requests[first + 2]); // its third round, before any reflection after it
    check("a login's link needs its site", /Pass site, the website the login is for/.test(replies[0] ?? ""));
    check("...and the link the model then gets has the site on it", /site=instacart\.com/.test(replies[1] ?? ""));
    check("a turn that minted a link asks the Worker to watch for the save", minted.status === 200 && minted.body?.vaultWatch === true);

    model.install([{ toolCalls: [{ name: "search", args: { query: "groceries" } }] }, { text: "Nothing on groceries yet." }]);
    const plain = await post(env, TOKEN_TEXTS, { question: "what's on my grocery list", conversation: "texts" });
    check("a turn that minted no link asks for no watch", plain.status === 200 && plain.body?.vaultWatch === undefined);

    model.install([{ toolCalls: [{ name: "manage", args: { action: "vault_add", args: { name: "Instacart" } } }] }, { text: "Couldn't make it." }]);
    const refused = await post(env, TOKEN_TEXTS, { question: "save my instacart login", conversation: "texts" });
    check("a link that was refused asks for no watch", refused.status === 200 && refused.body?.vaultWatch === undefined);

    /* ---------------- the save carries the task on ---------------- */

    model.install([{ text: "I'm signed in to Instacart. Building your cart from past orders now." }]);
    const eventAt = model.requests.length;
    const carried = await post(env, TOKEN_TEXTS, { question: "", event: "vault_saved", conversation: "texts" });
    const asked = lastUserText(model.requests[eventAt]);
    check("the event is a turn of its own, with no text of theirs", carried.status === 200 && /Building your cart/.test(carried.body?.answer ?? ""));
    check("...asked as the gateway's fixed line", asked.includes("they just saved what you asked for") && asked.includes("Carry on with the task"));
    const turns = conversationTurns(bucket);
    check("...kept in the history as that line, not as words of theirs", turns.at(-2)?.text === VAULT_SAVED_QUESTION);

    const before = model.requests.length;
    const app = await post(env, TOKEN_APP, { question: "", event: "vault_saved" });
    check("another client cannot name the event", app.status === 400 && model.requests.length === before);
    const job = { id: "job-instacart-1", title: "Instacart order", brief: "Build the cart.", attempt: 1 };
    const jobTurn = await post(env, TOKEN_TEXTS, { question: "", event: "vault_saved", conversation: "texts", job });
    check("a job's own turn cannot name it either", jobTurn.status === 400 && model.requests.length === before);
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
