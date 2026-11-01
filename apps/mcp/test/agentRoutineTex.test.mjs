/**
 * A ROUTINE IN TEX'S OWN FOLDER, END TO END THROUGH `/agent`.
 *
 * The owner decided on 2026-10-14 that new routines go in
 * `tex/routines/<how-often>/<name>.md` and that every `routines/` note keeps
 * running exactly as before, with nothing moved (`docs/decisions/routines.md`).
 * `agentRoutine.test.mjs` pins the old root, unchanged; these checks pin the
 * new one beside it in the same bucket:
 *
 *  - a `tex/routines/daily/` note runs on the routine's own connection;
 *  - its history is kept apart from a `routines/daily/` note of the same name,
 *    and each run is told only its own last answer;
 *  - a `tex/routines/once/` reminder runs once and is marked `done:`;
 *  - a text writes new routines there, is told to, and is refused a malformed
 *    one there; the write is reported to the control plane like the old root.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-14).
 *
 *  1. `routineRunsKey` giving the new root the old prefix, so the two notes
 *     share `.context/agent/routines/daily/standup.json`. → "a tex/routines/
 *     note's history is kept apart from its routines/ twin" and "each run is
 *     told only its own last answer" fail.
 *  2. `ROUTINE_ROOTS` without `tex/routines/`. → "a tex/routines/daily/ note
 *     runs on the routine's own connection" fails (400 `not_a_routine`).
 *  3. `refusalFor` matching only `routines/` again. → "a malformed routine
 *     under tex/routines/ is refused" fails.
 *  4. `ROUTINE_HELP` naming only `routines/`. → "a text is told new routines go
 *     in tex/routines/" fails.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  createControlPlaneStub,
  createS3Backend,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
} from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-routine-tex.test";
const TOKEN_RUNNER = `cat_texroutine_runner_${"0".repeat(18)}`;
const TOKEN_TEXTS = `cat_texroutine_texts_${"0".repeat(19)}`;

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

function userText(request) {
  const first = request?.messages?.[0]?.content;
  return typeof first === "string" ? first : JSON.stringify(first ?? "");
}

function toolReplies(request) {
  return (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content ?? ""));
}

export async function runAgentRoutineTexChecks(check) {
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
    controlPlane.addWorkspace("ws_texroutine", "texroutinely", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-texroutine",
      accessKeyId: "AKIAEXAMPLEEXAMPLEBB",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBB",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({
        accessToken,
        workspaceId: "ws_texroutine",
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId,
        userId: "user_writer",
      });
    await grant(TOKEN_RUNNER, "context_routines");
    await grant(TOKEN_TEXTS, "context_texts");
    controlPlane.setBuiltinVerdict("ws_texroutine", BUILTIN_ALLOWED);

    const bucket = s3.bucketFor("tenant-texroutine");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "g0" });
    bucket.set("tex/about-me.md", { body: "# About me\n", etag: "g1" });
    bucket.set("routines/daily/standup.md", { body: "---\nat: 9:00 am\n---\nSay what the old one says.\n", etag: "g2" });
    bucket.set("tex/routines/daily/standup.md", { body: "---\nat: 7:30 am\n---\nSay what the new one says.\n", etag: "g3" });
    bucket.set("tex/routines/once/call-sam.md", {
      body: "---\nat: 2026-10-15 9:00 am\n---\nRemind me to call Sam.\n",
      etag: "g4",
    });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const runsAt = (key) => {
      const object = bucket.get(key);
      return object ? JSON.parse(object.body).runs : [];
    };
    const OLD_HISTORY = ".context/agent/routines/daily/standup.json";
    const NEW_HISTORY = ".context/agent/tex/routines/daily/standup.json";

    /* ---------------- a run in the new root ---------------- */

    model.install([{ text: "New: the new one answered." }]);
    const fresh = await ask(env, TOKEN_RUNNER, { routine: { path: "tex/routines/daily/standup.md", timeZone: "UTC" } });
    check(
      "a tex/routines/daily/ note runs on the routine's own connection",
      fresh.status === 200 &&
        fresh.body?.outcome === "answered" &&
        userText(model.requests.at(-1)).includes("Routine: tex/routines/daily/standup.md") &&
        userText(model.requests.at(-1)).includes("Every day at 7:30 am") &&
        userText(model.requests.at(-1)).includes("Say what the new one says."),
    );

    model.install([{ text: "Old: the old one answered." }]);
    const old = await ask(env, TOKEN_RUNNER, { routine: { path: "routines/daily/standup.md", timeZone: "UTC" } });
    check(
      "its routines/ twin still runs, from its own words",
      old.status === 200 &&
        old.body?.outcome === "answered" &&
        userText(model.requests.at(-1)).includes("Say what the old one says.") &&
        // Its last answer is its own; the twin's text is only among the last texts, named as the other routine's (2026-10-23).
        !/you answered:(?:\\n|\s)+New: the new one answered/.test(userText(model.requests.at(-1))) &&
        userText(model.requests.at(-1)).includes("You (your routine tex/routines/daily/standup.md): New: the new one answered"),
    );
    check(
      "a tex/routines/ note's history is kept apart from its routines/ twin",
      runsAt(NEW_HISTORY).length === 1 &&
        runsAt(NEW_HISTORY)[0].text === "New: the new one answered." &&
        runsAt(OLD_HISTORY).length === 1 &&
        runsAt(OLD_HISTORY)[0].text === "Old: the old one answered.",
    );

    model.install([{ text: "SKIP" }]);
    await ask(env, TOKEN_RUNNER, { routine: { path: "tex/routines/daily/standup.md", timeZone: "UTC" } });
    const told = userText(model.requests.at(-1));
    check(
      "each run is told only its own last answer",
      /you answered:(?:\\n|\s)+New: the new one answered/.test(told) && !/you answered:(?:\\n|\s)+Old: the old one answered/.test(told),
    );

    /* ---------------- a one-off in the new root ---------------- */

    model.install([{ text: "Call Sam." }]);
    const reminded = await ask(env, TOKEN_RUNNER, { routine: { path: "tex/routines/once/call-sam.md", timeZone: "UTC" } });
    check(
      "a tex/routines/once/ reminder runs once, then stays where it is, marked done:",
      reminded.body?.outcome === "answered" &&
        userText(model.requests.at(-1)).includes("one-off reminder") &&
        /^done: /m.test(bucket.get("tex/routines/once/call-sam.md")?.body ?? "") &&
        runsAt(".context/agent/tex/routines/once/call-sam.json").length === 1,
    );

    /* ---------------- a text writes in the new root ---------------- */

    controlPlane.calls.length = 0;
    model.install([
      {
        toolCalls: [
          { name: "write_note", args: { path: "tex/routines/daily/due-today.md", content: "---\nat: 7:30 am\n---\nText me what's due.\n" } },
          { name: "write_note", args: { path: "tex/routines/sneaky.md", content: "x" } },
          { name: "write_note", args: { path: "tex/routines/someday/x.md", content: "x" } },
        ],
      },
      { text: "Done." },
    ]);
    const made = await ask(env, TOKEN_TEXTS, { question: "every morning at 7:30 tell me what's due" });
    const madeRequest = model.requests.at(-2);
    const writeTool = (madeRequest?.tools ?? []).find((tool) => tool.name === "write");
    check(
      "a text is told new routines go in tex/routines/, and that old ones still run",
      writeTool !== undefined &&
        writeTool.description.includes("tex/routines/<how-often>/<name>.md") &&
        writeTool.description.includes("tex/routines/once/") &&
        writeTool.description.includes("Older routines at routines/<how-often>/<name>.md still run"),
    );
    check(
      "a text writes a routine under tex/routines/",
      made.status === 200 && bucket.get("tex/routines/daily/due-today.md")?.body.includes("Text me what's due."),
    );
    const refusals = toolReplies(model.requests.at(-1));
    check(
      "a malformed routine under tex/routines/ is refused",
      bucket.get("tex/routines/sneaky.md") === undefined &&
        bucket.get("tex/routines/someday/x.md") === undefined &&
        refusals.filter((text) => text.includes("Only a routine file can be written under tex/routines/")).length === 2,
    );
    check(
      "the write is reported to the control plane, with its writer",
      controlPlane.calls.some(
        (call) =>
          call.path === "/gateway/routines" &&
          call.body?.userId === "user_writer" &&
          (call.body?.paths ?? []).includes("tex/routines/daily/due-today.md"),
      ),
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
