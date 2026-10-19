/**
 * TEX'S CHECK-IN, END TO END THROUGH `/agent` (owner, 2026-10-17).
 *
 * The check-in client's turn looks at the notes changed since the last look,
 * reads what matters, and answers one text or SKIP. It reads and does nothing
 * else, a look with nothing changed costs no model turn, `tex/heartbeat.md`
 * can pause it, and every look is logged in `tex/heartbeat/<day>.md`, one
 * that ran no model as a line saying why.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-17).
 *
 *  1. `heartbeatCallTool` passing every tool through.
 *     → "a check-in's dispatcher only reads, and only their own workspace" fails.
 *       (End to end the write is still refused: the turn's empty `grants` and
 *       read-only tool list are a second guard, which is why both exist.)
 *  2. `changedSince` counting Tex's own `tex/heartbeat/` log as a change.
 *     → "a look sees the notes changed since the last one…" fails.
 *  3. `handleHeartbeat` ignoring `paused: true`.
 *     → "paused in tex/heartbeat.md, it reads nothing and runs no model" fails.
 *  4. `http/route.js` sending the check-in client to the ordinary turn.
 *     → "only the check-in client checks in" fails.
 *  5. `handleHeartbeat` returning nothing_new without logging it (2026-10-19).
 *     → "a look with nothing changed still leaves a line…" fails.
 */

import worker from "../src/index.js";
import { transcriptPath } from "../src/agent/transcript.js";
import {
  CHECK_IN_QUESTION,
  NOTHING_NEW_WORDS,
  changedSince,
  newsFirst,
  checkInText,
  heartbeatCallTool,
  heartbeatPath,
  heartbeatQuestion,
  recentTextLines,
  readSettings,
  textedLines,
} from "../src/agent/heartbeat.js";
import { SKIPPED_WORDS } from "../src/agent/jobLog.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-heartbeat.test";
const TOKEN_BEAT = `cat_beat_heartbeat_${"0".repeat(20)}`;
const TOKEN_TEXTS = `cat_beat_texts_${"0".repeat(24)}`;
const TOKEN_APP = `cat_beat_app_${"0".repeat(26)}`;
const HOUR_MS = 60 * 60 * 1000;
const CONVERSATION = ".context/agent/conversations/texts.json";

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

/** One MCP tool call, as a connected app makes it. */
async function rpc(env, token, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body?.result;
}

function unitChecks(check) {
  const at = (iso) => new Date(iso);
  const since = Date.parse("2026-10-17T10:00:00Z");
  const changed = changedSince(
    [
      { key: "1-projects/launch.md", uploaded: at("2026-10-17T12:00:00Z") },
      { key: "tex/transcripts/2026-10-17.md", uploaded: at("2026-10-17T11:00:00Z") },
      { key: "todo.md", uploaded: at("2026-10-17T09:00:00Z") },
      { key: "tex/heartbeat/2026-10-17.md", uploaded: at("2026-10-17T12:30:00Z") },
      { key: "tex/dreams/2026-10-17.md", uploaded: at("2026-10-17T12:30:00Z") },
      { key: "tex/housekeeping/2026-10-17.md", uploaded: at("2026-10-17T12:30:00Z") },
      { key: "tex/about-me.md", uploaded: at("2026-10-17T12:30:00Z") },
      { key: "tex/heartbeat.md", uploaded: at("2026-10-17T12:30:00Z") },
      { key: ".context/agent/x.md", uploaded: at("2026-10-17T12:30:00Z") },
      { key: "files/photo.png", uploaded: at("2026-10-17T12:30:00Z") },
      { key: "no-date.md" },
    ],
    since,
  );
  check(
    "a look sees the notes changed since the last one, newest first, never Tex's own output or plumbing",
    JSON.stringify(changed.map((note) => note.key)) === JSON.stringify(["1-projects/launch.md", "tex/transcripts/2026-10-17.md"]),
  );
  const now = Date.parse("2026-10-19T16:11:00Z");
  const ordered = newsFirst(
    [
      { key: "0-inbox/contacts/someone.md", at: now - 1_000 },
      { key: "0-inbox/google-chat/2026/09/2026-09-25.md", at: now - 2_000 },
      { key: "1-projects/launch.md", at: now - 3_000 },
      { key: "0-inbox/email/me/2026/10/2026-10-19.md", at: now - 60 * 60 * 1000 },
      { key: "0-inbox/google-chat/2026/10/2026-10-18.md", at: now - 2 * 60 * 60 * 1000 },
    ],
    now,
  );
  check(
    "today's mail comes before weeks of rewritten chat days and contact pages, newest first within each",
    JSON.stringify(ordered.map((note) => note.key)) ===
      JSON.stringify([
        "1-projects/launch.md",
        "0-inbox/email/me/2026/10/2026-10-19.md",
        "0-inbox/google-chat/2026/10/2026-10-18.md",
        "0-inbox/contacts/someone.md",
        "0-inbox/google-chat/2026/09/2026-09-25.md",
      ]),
  );
  const paused = readSettings("---\npaused: true\n---\nOnly deadlines, please.\n");
  const open = readSettings("Only text me about deadlines.");
  check(
    "tex/heartbeat.md pauses it in its front matter, and its body is their instructions",
    paused.paused === true && paused.instructions === "Only deadlines, please." && open.paused === false &&
      open.instructions === "Only text me about deadlines." && readSettings("---\npaused: no\n---\n").paused === false,
  );
  check(
    "what earlier check-ins texted is read back from their logs",
    JSON.stringify(textedLines(["# Tex checked in\n\n## 10:00 am\n\n**Texted:** Your rent is due tomorrow.\n", "_Stayed quiet._"])) ===
      JSON.stringify(["Your rent is due tomorrow."]),
  );
  check(
    "SKIP, however it is dressed, is a quiet look; anything else is the text",
    checkInText("SKIP") === null && checkInText(" skip. ") === null && checkInText("SKIP: nothing new") === null &&
      checkInText("") === null && checkInText("Found the image you asked for.") === "Found the image you asked for.",
  );
  const asked = heartbeatQuestion({
    changed: [{ key: "todo.md", at: since }],
    now: since + 60_000,
    texted: [],
    instructions: "SETUP-WORDS: look only at deadlines.",
    theirs: "Only text me about rent.",
  });
  check(
    "the setup note's words replace the built-in ones; the changes, their words and SKIP are always said",
    asked.startsWith("SETUP-WORDS") && !asked.includes("glances at what changed") && asked.includes("- todo.md (1m ago)") &&
      asked.includes("Only text me about rent.") && asked.trim().endsWith("exactly SKIP and nothing else."),
  );
  const builtIn = heartbeatQuestion({ changed: [{ key: "todo.md", at: since }], now: since + 60_000, texted: [] });
  check(
    "a check-in texts like a person: short, and never a note path",
    builtIn.includes("one or two short sentences") && builtIn.includes("never a note path") && !builtIn.includes("which note it is in"),
  );
  const recent = recentTextLines([
    { role: "user", text: CHECK_IN_QUESTION },
    { role: "assistant", text: "The lane hold expires at 5 PM today. Want me to draft a reply?" },
    { role: "user", text: "what's the Oct 30 pricing" },
    { role: "assistant", text: "It's in a PDF I can't open." },
  ]);
  check(
    "a look sees the last texts with them, its own check-ins marked, and is told to continue rather than repeat",
    JSON.stringify(recent) ===
      JSON.stringify([
        "You (a check-in): The lane hold expires at 5 PM today. Want me to draft a reply?",
        "Them: what's the Oct 30 pricing",
        "You: It's in a PDF I can't open.",
      ]) &&
      heartbeatQuestion({ changed: [{ key: "todo.md", at: since }], now: since + 60_000, texted: [], recent }).includes(
        "never start it over with a new offer.\nYou (a check-in): The lane hold",
      ),
  );
  check("the day's log is dated in their zone", heartbeatPath(Date.UTC(2026, 9, 17, 3, 0), "America/New_York") === "tex/heartbeat/2026-10-16.md");
}

async function toolRefusals(check) {
  const calls = [];
  const callTool = heartbeatCallTool(async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "ok" }] };
  });
  const refusals = await Promise.all([
    callTool("write_note", { path: "todo.md", content: "x" }),
    callTool("move_note", { from: "todo.md", to: "4-archive/todo.md" }),
    callTool("set_visibility", { path: "todo.md", visibility: "team" }),
    callTool("open_page", { url: "https://example.invalid/" }),
    callTool("read_note", { path: "x.md", context: "@other" }),
    callTool("search_notes", { query: "x", context: "@other" }),
  ]);
  const allowed = await Promise.all([
    callTool("read_note", { path: "todo.md" }),
    callTool("search_notes", { query: "branding" }),
    callTool("list_notes", { prefix: "1-projects/" }),
  ]);
  check(
    "a check-in's dispatcher only reads, and only their own workspace",
    refusals.every((result) => result.isError === true) && allowed.every((result) => result.isError !== true) &&
      JSON.stringify(calls.map((call) => call.name)) === JSON.stringify(["read_note", "search_notes", "list_notes"]),
  );
}

export async function runAgentHeartbeatChecks(check) {
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
    controlPlane.addWorkspace("ws_beat", "beater", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-beat",
      accessKeyId: "AKIAEXAMPLEEXAMPLEHB",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEHB",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({
        accessToken,
        workspaceId: "ws_beat",
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId,
        userId: "user_beat",
      });
    await grant(TOKEN_BEAT, "context_heartbeat");
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_APP, "client_beat_app");
    controlPlane.setBuiltinVerdict("ws_beat", BUILTIN_ALLOWED);

    const bucket = s3.bucketFor("tenant-beat");
    const recently = new Date(Date.now() - HOUR_MS).toISOString();
    const today = transcriptPath(Date.now(), "UTC");
    const brandingNote = "1-projects/tex-branding/about.md";
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "h0" });
    bucket.set("todo.md", { body: "# To do\n\n- Pay rent\n", etag: "h1" });
    bucket.set(today, {
      body: "# Tex\n\n**Them:** can you send me the Tex branding image?\n\n**Tex:** Here's the board: https://example.invalid/board\n",
      etag: "h2",
      lastModified: recently,
    });
    bucket.set(brandingNote, {
      body: "# Tex branding\n\nThe image: https://example.invalid/tex-chaos-scale.png\n",
      etag: "h3",
      lastModified: recently,
    });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const log = () => bucket.get(heartbeatPath(Date.now(), "UTC"))?.body ?? "";
    const beat = (since = Date.now() - 2 * HOUR_MS) => ({ heartbeat: { timeZone: "UTC", since } });

    /* ---------------- who checks in ---------------- */

    const texted = await ask(env, TOKEN_TEXTS, beat());
    const asked = await ask(env, TOKEN_BEAT, { question: "what's on my list?" });
    check(
      "only the check-in client checks in, and it does nothing else",
      texted.status === 400 && asked.status === 400 && model.requests.length === 0,
    );

    /* ---------------- a look that finds something ---------------- */

    model.install([
      {
        thinking: "They asked for the branding image and only got the board.",
        toolCalls: [{ name: "read_note", args: { path: today } }, { name: "search_notes", args: { query: "Tex branding image" } }],
      },
      {
        toolCalls: [
          { name: "write_note", args: { path: "todo.md", content: "# To do\n\nhijacked\n" } },
          { name: "read_note", args: { path: brandingNote } },
        ],
      },
      { text: "Found the Tex branding image you asked for, in your branding notes:\nhttps://example.invalid/tex-chaos-scale.png" },
    ]);
    const found = await ask(env, TOKEN_BEAT, beat());
    check(
      "a check-in that finds an unfinished ask answers it as a text",
      found.status === 200 && found.body?.outcome === "speak" &&
        found.body?.answer?.includes("https://example.invalid/tex-chaos-scale.png"),
    );
    check("a check-in can't write, whatever it is told", bucket.get("todo.md")?.body === "# To do\n\n- Pay rent\n");
    const written = log();
    check(
      "the log says what it looked at, what it texted, and every step",
      written.startsWith("# Tex checked in,") &&
        written.includes(`\`${brandingNote}\``) &&
        written.includes(`\`${today}\``) &&
        written.includes("**Texted:** Found the Tex branding image you asked for, in your branding notes: https://example.invalid/tex-chaos-scale.png") &&
        written.includes("> 💭 They asked for the branding image and only got the board.") &&
        written.includes("`write_note` `{\"path\":\"todo.md\""),
    );
    const conversation = JSON.parse(bucket.get(CONVERSATION)?.body ?? "{}");
    check(
      "a texted check-in joins the texting conversation, so a reply has it in front of it",
      conversation.turns?.at(-2)?.text === CHECK_IN_QUESTION &&
        conversation.turns?.at(-1)?.text?.includes("tex-chaos-scale.png"),
    );
    const prompt = JSON.stringify(model.requests[0]);
    check(
      "the look is shown what changed and told most looks stay quiet",
      prompt.includes(brandingNote) && prompt.includes("your check-in") && prompt.includes("exactly SKIP") &&
        !prompt.includes("tex/heartbeat/"),
    );

    /* ---------------- a quiet look ---------------- */

    model.install([{ text: "SKIP" }]);
    const quiet = await ask(env, TOKEN_BEAT, beat());
    check(
      "a look with nothing worth a text stays quiet, in the same day's log",
      quiet.status === 200 && quiet.body?.outcome === "quiet" && quiet.body?.answer === undefined &&
        log().includes("_Stayed quiet: nothing worth a text._") && (log().match(/^## /gm) ?? []).length === 2,
    );
    check(
      "the next look is told what the last one already texted",
      JSON.stringify(model.requests.at(-1)).includes("Never send any of these again") &&
        JSON.stringify(model.requests.at(-1)).includes("Found the Tex branding image you asked for"),
    );

    /* ---------------- nothing changed ---------------- */

    const before = model.requests.length;
    const nothing = await ask(env, TOKEN_BEAT, beat(Date.now() - 10 * 60 * 1000));
    check(
      "nothing changed since the last look is nothing_new, with no model turn",
      nothing.status === 200 && nothing.body?.outcome === "nothing_new" && model.requests.length === before,
    );
    check(
      "a look with nothing changed still leaves a line in the day's log, saying why it ran no model",
      log().includes(`_${NOTHING_NEW_WORDS}_`) && (log().match(/^## /gm) ?? []).length === 3,
    );

    /* ---------------- no model to run ---------------- */

    controlPlane.setBuiltinVerdict("ws_beat", { allowed: false, reason: "not_premium" });
    const refusedLook = await ask(env, TOKEN_BEAT, beat());
    controlPlane.setBuiltinVerdict("ws_beat", { allowed: false, reason: "daily_cap" });
    const capped = await ask(env, TOKEN_BEAT, beat());
    controlPlane.setBuiltinVerdict("ws_beat", BUILTIN_ALLOWED);
    check(
      "a look refused the model, or past today's cap, says so in the day's log and runs no model",
      refusedLook.status === 409 && capped.status === 429 && model.requests.length === before &&
        log().includes(`_${SKIPPED_WORDS.no_provider}_`) && log().includes(`_${SKIPPED_WORDS.daily_limit}_`),
    );

    /* ---------------- their instructions ---------------- */

    bucket.set("tex/heartbeat.md", { body: "Only text me about deadlines.\n", etag: "h4", lastModified: new Date().toISOString() });
    model.install([{ text: "SKIP" }]);
    await ask(env, TOKEN_BEAT, beat());
    check(
      "their own instructions in tex/heartbeat.md reach the look",
      JSON.stringify(model.requests.at(-1)).includes("Only text me about deadlines."),
    );

    /* ---------------- paused ---------------- */

    // Through the gateway, as the app or Tex would write it: the note's saved state is the collaboration doc's.
    const current = await rpc(env, TOKEN_APP, "read_note", { path: "tex/heartbeat.md" });
    const etag = /^etag: (.+)$/m.exec(current?.content?.[0]?.text ?? "")?.[1]?.trim();
    const paused = await rpc(env, TOKEN_APP, "write_note", {
      path: "tex/heartbeat.md",
      content: "---\npaused: true\n---\nOnly text me about deadlines.\n",
      expected_etag: etag,
    });
    const looked = model.requests.length;
    const stopped = await ask(env, TOKEN_BEAT, beat());
    check(
      "paused in tex/heartbeat.md, it reads nothing and runs no model",
      paused?.isError !== true && stopped.status === 200 && stopped.body?.outcome === "paused" && model.requests.length === looked,
    );
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
