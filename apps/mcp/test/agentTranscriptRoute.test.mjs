/**
 * NO DAILY TRANSCRIPT, AND TEXTED PICTURES KEPT IN A NOTE OF THEIR OWN,
 * END TO END THROUGH `/agent` (owner, 2026-11-02).
 *
 * The daily transcripts (`tex/transcripts/<day>.md`, written from 2026-10-15)
 * are retired: the chat's ledger is its one record (`chat-ledger.md`). These
 * pin the wiring: a texted turn writes no transcript note; it still asks the
 * model for its thinking in words (the ledger keeps it); a texted picture is
 * stored once in the workspace's images and embedded in the month's
 * `tex/pictures/` note, which the saved conversation names so a later text
 * can look again; a turn from any other client writes no pictures note.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-02).
 *
 *  1. `route.js` calling `attachmentsLine` without the kept pictures.
 *     → "the saved conversation points at a stored picture, never its bytes" fails.
 *  2. `route.js` keeping pictures for every client.
 *     → "a turn from another client keeps no pictures note" fails.
 *  3. `anthropicMessages` dropping a tool result's images (2026-10-20).
 *     → "a picture read back with read_image is shown to the model in the tool's answer" fails.
 */

import worker from "../src/index.js";
import { transcriptPath } from "../src/agent/transcript.js";
import { picturesPath } from "../src/agent/textedPictures.js";
import { IMAGE_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  createControlPlaneStub,
  createS3Backend,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
} from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { texStoreNamespace, withAgentHome } from "./texStoreFixture.mjs";
import { conversationText } from "./agentConversationFixture.mjs";
import { textTex } from "./agentEgressFixtures.mjs";

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
      if (next.waitMs) await new Promise((resolve) => setTimeout(resolve, next.waitMs));
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
    const tex = texStoreNamespace();
    const history = withAgentHome(bucket, tex, "ws_transcript"); // the texting history is the person's object's (`texStoreFixture.mjs`)
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: tex.namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const day = () => bucket.get(transcriptPath(Date.now(), "UTC"))?.body ?? "";

    /* ---------------- a texted turn ---------------- */

    model.install([
      { thinking: "They want the to-do list.", text: "Checking.", toolCalls: [{ name: "read_note", args: { path: "todo.md" } }] },
      { text: "Pay rent." },
    ]);
    const first = await ask(env, TOKEN_TEXTS, { question: "what's on my list?", conversation: "texts", timeZone: "UTC" });
    check(
      "a texted turn writes no daily transcript",
      first.status === 200 && first.body?.answer === "Pay rent." && day() === "" &&
        ![...bucket.keys()].some((key) => key.startsWith("tex/transcripts/")),
    );
    check(
      "a texted turn asks the model for its thinking in words",
      model.requests.length > 0 && model.requests.every((request) => request.thinking?.display === "summarized"),
    );

    /* ---------------- what they sent ---------------- */

    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    model.install([{ text: "Cute." }]);
    // As the Worker sends it (`textTex`): the chat's ledger is what a later text reads.
    const pictured = await textTex(env, TOKEN_TEXTS, "look at this", { timeZone: "UTC", attachments: [{ name: "IMG_7.png", mediaType: "image/png", data: PNG }] }, { logged: false });
    const note = picturesPath(Date.now(), "UTC");
    const album = () => bucket.get(note)?.body ?? "";
    const leaf = /!\[\[(upload-[0-9a-f]{16}\.png)\|IMG_7\.png\]\]/.exec(album())?.[1];
    check(
      "a texted picture is stored in the workspace's images and shown in the month's pictures note",
      pictured.status === 200 && leaf !== undefined && bucket.get(`${IMAGE_PREFIX}${leaf}`) !== undefined && day() === "",
    );
    const kept = conversationText(history);
    check(
      "the saved conversation points at a stored picture, never its bytes",
      leaf !== undefined && kept.includes(`IMG_7.png (image ${leaf} in ${note})`) && kept.includes("read_image") && !kept.includes(PNG.slice(0, 40)),
    );

    // "it took me here", a text later: the picture is looked at again, and the model is shown it.
    model.install([{ toolCalls: [{ name: "read_image", args: { note, image: leaf } }] }, { text: "Same page." }]);
    const again = await textTex(env, TOKEN_TEXTS, "it took me here", { timeZone: "UTC" }, { logged: false });
    const shown = model.requests
      .at(-1)
      ?.messages?.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === "tool_result");
    check(
      "a picture read back with read_image is shown to the model in the tool's answer",
      again.status === 200 &&
        Array.isArray(shown?.content) &&
        shown.content.some((block) => block.type === "image" && block.source?.type === "base64" && block.source.data.length > 0),
    );

    /* ---------------- another client ---------------- */

    const before = album();
    model.install([{ text: "Hello." }]);
    const other = await ask(env, TOKEN_OTHER, { question: "hello from elsewhere", attachments: [{ name: "IMG_8.png", mediaType: "image/png", data: PNG }] });
    check(
      "a turn from another client keeps no pictures note",
      other.status === 200 && album() === before && !album().includes("IMG_8") && model.requests.at(-1)?.thinking === undefined,
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
