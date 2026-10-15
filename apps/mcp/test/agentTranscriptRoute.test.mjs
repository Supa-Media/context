/**
 * TEX'S DAILY TRANSCRIPT, END TO END THROUGH `/agent` (owner, 2026-10-15).
 *
 * `agentTranscript.test.mjs` pins the note's shape; these pin the wiring: a
 * texted turn writes `tex/transcripts/<day>.md` in the person's bucket with
 * the text, the thinking, the call and the answer (never the call's result),
 * asks the model for its thinking in words, and keeps going for the next
 * text; a turn from any other client writes nothing.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-15).
 *
 *  1. `route.js` opening the transcript only when `runner`.
 *     → "a texted turn is written into today's transcript" fails.
 *  2. `route.js` opening it for every client.
 *     → "a turn from another client writes no transcript" fails.
 */

import worker from "../src/index.js";
import { transcriptPath } from "../src/agent/transcript.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  createControlPlaneStub,
  createS3Backend,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
} from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-transcript.test";
const TOKEN_TEXTS = `cat_transcript_texts_${"0".repeat(19)}`;
const TOKEN_OTHER = `cat_transcript_other_${"0".repeat(19)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  4-archive: private\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

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
      const content = [];
      if (next.thinking) content.push({ type: "thinking", thinking: next.thinking, signature: "sig" });
      if (next.text) content.push({ type: "text", text: next.text });
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

export async function runAgentTranscriptChecks(check) {
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
    controlPlane.addWorkspace("ws_transcript", "transcripted", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-transcript",
      accessKeyId: "AKIAEXAMPLEEXAMPLECC",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLECC",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({
        accessToken,
        workspaceId: "ws_transcript",
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId,
        userId: "user_transcript",
      });
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_OTHER, "some_other_client");
    controlPlane.setBuiltinVerdict("ws_transcript", BUILTIN_ALLOWED);

    const bucket = s3.bucketFor("tenant-transcript");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "t0" });
    bucket.set("todo.md", { body: "# To do\n\n- Pay rent RESULT-ONLY-WORDS\n", etag: "t1" });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const day = () => bucket.get(transcriptPath(Date.now(), "UTC"))?.body ?? "";

    /* ---------------- a texted turn ---------------- */

    model.install([
      { thinking: "They want the to-do list.", text: "Checking.", toolCalls: [{ name: "read_note", args: { path: "todo.md" } }] },
      { text: "Pay rent." },
    ]);
    const first = await ask(env, TOKEN_TEXTS, { question: "what's on my list?", conversation: "texts", timeZone: "UTC" });
    const written = day();
    check(
      "a texted turn is written into today's transcript",
      first.status === 200 &&
        first.body?.answer === "Pay rent." &&
        written.includes("**Them:** what's on my list?") &&
        written.includes("> 💭 They want the to-do list.") &&
        written.includes("**Tex, while working:** Checking.") &&
        written.includes('`read_note` `{"path":"todo.md"}` → ok') &&
        written.includes("**Tex:** Pay rent.") &&
        !written.includes("working_"),
    );
    check("a tool's result never goes in the transcript", written !== "" && !written.includes("RESULT-ONLY-WORDS"));
    check(
      "a texted turn asks the model for its thinking in words",
      model.requests.length > 0 && model.requests.every((request) => request.thinking?.display === "summarized"),
    );

    model.install([{ text: "Anytime." }]);
    await ask(env, TOKEN_TEXTS, { question: "thanks", conversation: "texts", timeZone: "UTC" });
    const both = day();
    check(
      "the next text goes after the first, in the same day's note",
      both.indexOf("what's on my list?") !== -1 &&
        both.indexOf("**Them:** thanks") > both.indexOf("**Tex:** Pay rent.") &&
        both.includes("**Tex:** Anytime."),
    );

    /* ---------------- another client ---------------- */

    const before = day();
    model.install([{ text: "Hello." }]);
    const other = await ask(env, TOKEN_OTHER, { question: "hello from elsewhere" });
    check(
      "a turn from another client writes no transcript",
      other.status === 200 && day() === before && !day().includes("hello from elsewhere") &&
        model.requests.at(-1)?.thinking === undefined,
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
