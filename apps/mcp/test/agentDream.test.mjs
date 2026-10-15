/**
 * TEX'S NIGHTLY DREAM, END TO END THROUGH `/agent` (owner, 2026-10-15).
 *
 * The dreams client's turn reads the transcripts written since the last
 * dream, rewrites `tex/about-me.md`, and logs what it read, thought and
 * changed in `tex/dreams/<day>.md`. It can write that one note and nothing
 * else, a quiet night costs no model turn, and only the dreams client dreams.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-15).
 *
 *  1. `dreamCallTool` passing every write_note through.
 *     → "a dream's dispatcher refuses every write but the note's own text…" fails.
 *  2. `handleDream` running the model on a night with no transcripts.
 *     → "a quiet night is nothing_new and costs no model turn" fails.
 *  3. `route.js` sending a dream body from any client to `handleDream` unchecked
 *     (the `dreamer` test in `handleDream` removed).
 *     → "only the dreams client dreams" fails.
 *  4. `dreamEntry` leaving out the removed lines.
 *     → "the log says exactly what changed…" fails.
 */

import worker from "../src/index.js";
import { transcriptPath } from "../src/agent/transcript.js";
import {
  aboutMeChanges,
  dreamCallTool,
  dreamPath,
  transcriptsToRead,
  MAX_DREAM_TRANSCRIPTS,
} from "../src/agent/dream.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-dream.test";
const TOKEN_DREAMS = `cat_dream_dreams_${"0".repeat(22)}`;
const TOKEN_TEXTS = `cat_dream_texts_${"0".repeat(23)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

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
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      // A step may be worked out from the request, as a model reads its tool results.
      const next = typeof step === "function" ? step(JSON.stringify(requests.at(-1))) : step;
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

function unitChecks(check) {
  const now = Date.UTC(2026, 9, 16, 3, 0);
  const listing = [
    "tex/transcripts/2026-10-12.md (10 bytes)",
    "tex/transcripts/2026-10-14.md (10 bytes)",
    "tex/transcripts/2026-10-15-2.md (10 bytes)",
    "tex/transcripts/2026-10-15.md (10 bytes)",
    "tex/transcripts/notes.md (10 bytes)",
    "tex/about-me.md (10 bytes)",
  ].join("\n");
  check(
    "a dream reads the days since the last one, in order, parts after the first",
    JSON.stringify(transcriptsToRead(listing, { since: Date.UTC(2026, 9, 14, 3, 0), now, timeZone: "UTC" })) ===
      JSON.stringify(["tex/transcripts/2026-10-14.md", "tex/transcripts/2026-10-15.md", "tex/transcripts/2026-10-15-2.md"]),
  );
  check(
    "a first dream looks back three days",
    JSON.stringify(transcriptsToRead(listing, { since: null, now, timeZone: "UTC" })) ===
      JSON.stringify(["tex/transcripts/2026-10-14.md", "tex/transcripts/2026-10-15.md", "tex/transcripts/2026-10-15-2.md"]),
  );
  const many = Array.from({ length: 10 }, (_, i) => `tex/transcripts/2026-10-${String(i + 1).padStart(2, "0")}.md (1 bytes)`).join("\n");
  const kept = transcriptsToRead(many, { since: Date.UTC(2026, 9, 1), now: Date.UTC(2026, 9, 11), timeZone: "UTC" });
  check(
    "a long gap reads only the newest few days",
    kept.length === MAX_DREAM_TRANSCRIPTS && kept.at(-1) === "tex/transcripts/2026-10-10.md",
  );
  const changes = aboutMeChanges("# About\n\n- Likes tea\n- Lives in Leeds\n", "# About\n- Likes tea\n- Lives in York\n- Has a dog\n");
  check(
    "the changes are the lines added and removed, blank lines aside",
    JSON.stringify(changes) === JSON.stringify({ added: ["- Lives in York", "- Has a dog"], removed: ["- Lives in Leeds"] }),
  );
  check("the night's log is dated in their zone", dreamPath(Date.UTC(2026, 9, 16, 3, 0), "America/New_York") === "tex/dreams/2026-10-15.md");
}

async function toolRefusals(check) {
  const calls = [];
  const callTool = dreamCallTool(async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "ok" }] };
  });
  const refusals = await Promise.all([
    callTool("write_note", { path: "todo.md", content: "x" }),
    callTool("write_note", { path: "tex/about-me.md", content: "x", visibility: "team" }),
    callTool("write_note", { path: "tex/about-me.md", content: "x", context: "@other" }),
    callTool("read_note", { path: "x.md", context: "@other" }),
    callTool("set_visibility", { path: "tex/about-me.md", visibility: "team" }),
    callTool("search_notes", { query: "x" }),
  ]);
  const allowed = await callTool("write_note", { path: "tex/about-me.md", content: "# About\n", expected_etag: "e1", summary: undefined });
  check(
    "a dream's dispatcher refuses every write but the note's own text, and every other workspace",
    refusals.every((result) => result.isError === true) &&
      allowed.isError !== true &&
      calls.length === 1 &&
      JSON.stringify(calls[0]) === JSON.stringify({ name: "write_note", args: { path: "tex/about-me.md", content: "# About\n", expected_etag: "e1" } }),
  );
}

export async function runAgentDreamChecks(check) {
  unitChecks(check);
  await toolRefusals(check);

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
    controlPlane.addWorkspace("ws_dream", "dreamer", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-dream",
      accessKeyId: "AKIAEXAMPLEEXAMPLEDD",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEDD",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({
        accessToken,
        workspaceId: "ws_dream",
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId,
        userId: "user_dream",
      });
    await grant(TOKEN_DREAMS, "context_dreams");
    await grant(TOKEN_TEXTS, "context_texts");
    controlPlane.setBuiltinVerdict("ws_dream", BUILTIN_ALLOWED);

    const bucket = s3.bucketFor("tenant-dream");
    const today = transcriptPath(Date.now(), "UTC");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "d0" });
    bucket.set("todo.md", { body: "# To do\n\n- Pay rent\n", etag: "d1" });
    bucket.set("tex/about-me.md", { body: "# About them\n\n- Lives in Leeds\n- Likes tea\n", etag: "d2" });
    bucket.set(today, { body: "# Tex\n\n**Them:** I moved to York last week, and the dog says hi\n", etag: "d3" });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const log = () => bucket.get(dreamPath(Date.now(), "UTC"))?.body ?? "";
    const dream = (since = Date.now() - DAY_MS) => ({ dream: { timeZone: "UTC", since } });

    /* ---------------- who dreams ---------------- */

    const texted = await ask(env, TOKEN_TEXTS, dream());
    const asked = await ask(env, TOKEN_DREAMS, { question: "what's on my list?" });
    check(
      "only the dreams client dreams, and it does nothing else",
      texted.status === 403 && asked.status === 400 && model.requests.length === 0,
    );

    /* ---------------- a dream that learns ---------------- */

    model.install([
      {
        thinking: "They moved, and they have a dog.",
        toolCalls: [{ name: "read_note", args: { path: today } }, { name: "read_note", args: { path: "tex/about-me.md" } }],
      },
      (seen) => ({
        toolCalls: [
          { name: "write_note", args: { path: "todo.md", content: "# To do\n\nhijacked\n" } },
          {
            name: "write_note",
            args: {
              path: "tex/about-me.md",
              content: "# About them\n\n- Lives in York\n- Likes tea\n- Has a dog\n",
              // The etag the read before this answered with, the way the model is told to.
              expected_etag: [...seen.matchAll(/etag: ([^\\\s]+)/g)].at(-1)?.[1],
            },
          },
        ],
      }),
      { text: "They moved from Leeds to York and have a dog." },
    ]);
    const learned = await ask(env, TOKEN_DREAMS, dream());
    const about = bucket.get("tex/about-me.md")?.body ?? "";
    check(
      "a dream rewrites tex/about-me.md from the day's texts",
      learned.status === 200 && learned.body?.outcome === "dreamed" && about.includes("- Lives in York") && about.includes("- Has a dog"),
    );
    check("a dream can write tex/about-me.md and nothing else", bucket.get("todo.md")?.body === "# To do\n\n- Pay rent\n");
    const written = log();
    check(
      "the log says exactly what changed, why, and every step it took",
      written.startsWith("# Tex dreamed,") &&
        written.includes(`_Read \`${today}\``) &&
        written.includes("- Added `- Lives in York`") &&
        written.includes("- Added `- Has a dog`") &&
        written.includes("- Removed `- Lives in Leeds`") &&
        !written.includes("Removed `- Likes tea`") &&
        written.includes("They moved from Leeds to York and have a dog.") &&
        written.includes("> 💭 They moved, and they have a dog.") &&
        written.includes(`\`read_note\` \`{"path":"${today}"}\` → ok`) &&
        written.includes("`write_note` `{\"path\":\"todo.md\"") &&
        !written.includes("hi\n**"),
    );
    const prompt = JSON.stringify(model.requests[0]);
    check(
      "the dream is shown the note and pointed at the transcripts",
      prompt.includes("Lives in Leeds") && prompt.includes(today) && prompt.includes("nightly dream") &&
        !prompt.includes("read it only when they ask about an earlier conversation"),
    );

    /* ---------------- a dream that keeps everything ---------------- */

    model.install([{ text: "Nothing new worth keeping." }]);
    const kept = await ask(env, TOKEN_DREAMS, dream());
    check(
      "a dream that changes nothing says so, in the same night's log",
      kept.status === 200 && kept.body?.outcome === "unchanged" && log().includes("_Nothing changed._") &&
        (log().match(/^## /gm) ?? []).length === 2,
    );

    /* ---------------- a quiet night ---------------- */

    const before = model.requests.length;
    const quiet = await ask(env, TOKEN_DREAMS, dream(Date.now() + DAY_MS));
    check(
      "a quiet night is nothing_new and costs no model turn",
      quiet.status === 200 && quiet.body?.outcome === "nothing_new" && model.requests.length === before,
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
