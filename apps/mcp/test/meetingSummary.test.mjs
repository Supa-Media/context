/**
 * MEETING SUMMARIES, END TO END THROUGH `POST /meetings/summary`.
 *
 * The rules for what a summary says are `packages/meetings/test/summary.test.mjs`;
 * the control plane's gate is `apps/convex/__tests__/meetingSummary.test.ts`.
 * These are the gateway's half:
 *
 *  - only a grant that may write the note can summarize it;
 *  - the model is called only after the control plane said yes, and is forced
 *    to answer through the summary tool, twice (write, then check);
 *  - the summary replaces its own section and nothing else, even when somebody
 *    edited the note while the model was writing;
 *  - a summary a person wrote is never replaced unless Redo asked;
 *  - what goes back to the meter is counts, never text.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are FAIL lines here.
 *
 *   `writeSummary` not re-reading after a conflict                           3
 *   the route asking for read instead of write                                9
 *   `summarizeMeetingNote` skipping the control plane                         5
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { SUMMARY_FAILED, SUMMARY_TOO_SHORT, SUMMARY_WAITING_PREFIX } from "../../../packages/meetings/src/summary.js";
import { TRANSCRIPT_CAVEAT, SUMMARY_PLACEHOLDER } from "../../../packages/meetings/src/note.js";

const S3_ENDPOINT = "https://s3.example-meeting-summary.test";
const TOKEN = `cat_summary_owner_${"0".repeat(22)}`;
const TOKEN_READER = `cat_summary_reader_${"0".repeat(21)}`;
const PATH = "2-areas/meetings/2026-10-08-grant-writing.md";

const SPOKEN = Array.from(
  { length: 30 },
  (_, i) => `**[00:${String(i).padStart(2, "0")}:00] Kenzie** — We should budget about five thousand for the gatherings next year, item ${i}.`,
).join("\n");

function meeting({ summary = SUMMARY_PLACEHOLDER, notes = "ask about budget", transcript = SPOKEN, status = "complete", type = "meeting" } = {}) {
  return [
    "---",
    `type: "${type}"`,
    'started: "2026-10-08T23:03:12.147Z"',
    `status: "${status}"`,
    "---",
    "",
    "# Grant Writing Collab",
    "",
    "## Summary",
    "",
    summary,
    "",
    "## My notes",
    "",
    notes,
    "",
    "## Transcript",
    "",
    TRANSCRIPT_CAVEAT,
    "",
    transcript,
    "",
  ].join("\n");
}

const DRAFT = {
  summary: ["The team will apply again for the grant."],
  decisions: ["Revise last year's application"],
  tables: [],
  chart: null,
  action_items: [{ owner: "Kenzie", task: "Draft the budget", due: "2026-10-12" }],
  open_questions: [],
};
const CHECKED = { ...DRAFT, summary: ["The team will apply again for the grant, due October 15."] };

function toolAnswer(input, { input: inTokens = 1000, output = 200 } = {}) {
  return {
    content: [{ type: "tool_use", id: "toolu_1", name: "write_meeting_summary", input }],
    stop_reason: "tool_use",
    usage: { input_tokens: inTokens, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

async function summarize(env, token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/meetings/summary", {
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

export async function runMeetingSummaryChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const gatewayCalls = [];
  let gatewayReplies = [];
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      gatewayCalls.push({ headers: { ...init?.headers }, body: JSON.parse(init.body) });
      const next = gatewayReplies.shift();
      if (!next) throw new Error("fixture: the gateway script ran out");
      if (typeof next === "function") return next();
      return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return withStubs(input, init);
  };

  const bucket = () => s3.bucketFor("tenant-summary");
  // A fixture that rewrites the file behind the gateway also drops the note's
  // editing history, as a fresh note would have none: the gateway otherwise
  // (rightly) keeps reading the history it already holds.
  const put = (text, etag) => {
    for (const key of [...bucket().keys()]) if (key.startsWith(".context/collaboration/")) bucket().delete(key);
    bucket().set(PATH, { body: text, etag });
  };
  const stored = () => bucket().get(PATH)?.body ?? "";
  const summaryOf = (text) => text.slice(text.indexOf("## Summary"), text.indexOf("## My notes"));
  const tailOf = (text) => text.slice(text.indexOf("## My notes"));

  try {
    for (const [id, slug, name] of [
      ["ws_summary", "summary", "tenant-summary"],
      ["ws_other", "othersummary", "tenant-other-summary"],
    ]) {
      controlPlane.addWorkspace(id, slug, {
        provider: "s3",
        status: "active",
        endpoint: S3_ENDPOINT,
        region: "auto",
        bucket: name,
        accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
        forcePathStyle: true,
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      });
    }
    await controlPlane.addGrant({
      accessToken: TOKEN,
      workspaceId: "ws_summary",
      scopes: ["context:read", "context:write", "context:private"],
      userId: "user_summary",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_READER,
      workspaceId: "ws_summary",
      scopes: ["context:read", "context:private"],
      userId: "user_reader",
    });
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      AI_GATEWAY_ID: "context-gw",
      AI_GATEWAY_TOKEN: "gateway-token-fixture-0000000000",
    };

    /* ---------------- refused or skipped before anything is spent ---------------- */

    put(meeting(), "m1");
    const reader = await summarize(env, TOKEN_READER, { path: PATH });
    check("a read-only grant cannot summarize, and the model is never called", reader.status === 403 && gatewayCalls.length === 0);
    check("a body no app sends is a 400", (await summarize(env, TOKEN, { path: 7 })).status === 400);

    bucket().set("1-projects/plan.md", { body: "# Plan\n\n## Summary\n\nx\n", etag: "p1" });
    const plain = await summarize(env, TOKEN, { path: "1-projects/plan.md", force: true });
    check("an ordinary note is not a meeting", plain.body?.status === "skipped" && gatewayCalls.length === 0);

    put(meeting({ status: "recording" }), "m2");
    const live = await summarize(env, TOKEN, { path: PATH });
    check("a meeting still recording waits until it ends", live.body?.status === "recording" && gatewayCalls.length === 0 && summaryOf(stored()).includes(SUMMARY_PLACEHOLDER));

    put(meeting({ transcript: "**[00:00:01] Shay** — hi, see you Sunday" }), "m3");
    const short = await summarize(env, TOKEN, { path: PATH });
    check(
      "a hallway hello gets its one line, with no model call and no allowance spent",
      short.body?.status === "too_short" && gatewayCalls.length === 0 && summaryOf(stored()).includes(SUMMARY_TOO_SHORT),
    );

    put(meeting(), "m4");
    const unconfigured = await summarize({ ...env, AI_GATEWAY_TOKEN: undefined }, TOKEN, { path: PATH });
    check("a deployment with no AI gateway says unavailable and writes nothing", unconfigured.body?.status === "unavailable" && stored() === meeting());

    controlPlane.setMeetingSummaryVerdict("ws_summary", { allowed: false, reason: "daily_cap", paying: false });
    const capped = await summarize(env, TOKEN, { path: PATH });
    check(
      "past the daily allowance the note says it will be summarized tomorrow, and the model is never called",
      capped.body?.status === "waiting" && gatewayCalls.length === 0 && summaryOf(stored()).includes(SUMMARY_WAITING_PREFIX),
    );
    controlPlane.setMeetingSummaryVerdict("ws_summary", { allowed: true, remaining: 9, paying: false });

    /* ---------------- a summary ---------------- */

    put(meeting(), "m5");
    gatewayReplies = [toolAnswer(DRAFT), toolAnswer(CHECKED, { input: 1200, output: 150 })];
    const written = await summarize(env, TOKEN, { path: PATH });
    const after = stored();
    check("a finished meeting is summarized", written.status === 200 && written.body?.status === "written");
    check("it took a write and a check", gatewayCalls.length === 2);
    check(
      "the model is forced to answer through the summary tool",
      gatewayCalls.every((call) => call.body.tool_choice?.name === "write_meeting_summary" && call.body.tools.length === 1),
    );
    check("the model is ours, never the caller's", gatewayCalls.every((call) => call.body.model === "claude-haiku-5-5"));
    check("the checked version is the one written", summaryOf(after).includes("due October 15") && summaryOf(after).includes("- [ ] Kenzie: Draft the budget (due 2026-10-12)"));
    check("their notes and the transcript are untouched", tailOf(after) === tailOf(meeting()));
    check("the gateway files the cost under the feature, by id only", /"feature":"meetingSummary"/.test(gatewayCalls[0].headers["cf-aig-metadata"] ?? ""));
    const report = controlPlane.meetingSummaryReports.at(-1);
    check(
      "the meter is told both calls' counts",
      report?.workspaceId === "ws_summary" && report.inputTokens === 2200 && report.outputTokens === 350 && report.failed === false,
    );
    check("the meter is never told a word of the meeting", !JSON.stringify(controlPlane.meetingSummaryReports).includes("Kenzie"));

    const again = await summarize(env, TOKEN, { path: PATH });
    check("a written summary is not replaced on its own", again.body?.status === "skipped" && gatewayCalls.length === 2 && stored() === after);

    /* ---------------- Redo ---------------- */

    gatewayReplies = [toolAnswer({ ...DRAFT, summary: ["Budget first."] }), toolAnswer({ ...DRAFT, summary: ["Budget first."] })];
    const redo = await summarize(env, TOKEN, { path: PATH, force: true, instruction: "Focus on the budget" });
    check("Redo replaces the summary", redo.body?.status === "written" && summaryOf(stored()).includes("Budget first."));
    check("Redo's instruction reaches the model", JSON.stringify(gatewayCalls[2].body.messages).includes("Focus on the budget"));

    const beforeFailedRedo = stored();
    gatewayReplies = [{ content: [{ type: "text", text: "no tool" }], stop_reason: "end_turn", usage: {} }];
    const failedRedo = await summarize(env, TOKEN, { path: PATH, force: true });
    check("a Redo that fails keeps the summary that was there", failedRedo.body?.status === "failed" && stored() === beforeFailedRedo);
    check("a failed summary is reported as failed", controlPlane.meetingSummaryReports.at(-1)?.failed === true);

    /* ---------------- failure and recovery ---------------- */

    put(meeting(), "m6");
    gatewayReplies = [() => new Response("{}", { status: 500 })];
    const failed = await summarize(env, TOKEN, { path: PATH });
    check("an empty section that failed says so, for the next open to retry", failed.body?.status === "failed" && summaryOf(stored()).includes(SUMMARY_FAILED));

    gatewayReplies = [toolAnswer(DRAFT), () => new Response("{}", { status: 500 })];
    const unchecked = await summarize(env, TOKEN, { path: PATH });
    check("a failed check keeps the draft", unchecked.body?.status === "written" && summaryOf(stored()).includes("The team will apply again for the grant."));

    /* ---------------- somebody typing meanwhile ---------------- */

    put(meeting(), "m7");
    const typed = meeting({ notes: "ask about budget\nand the venue, typed during the summary" });
    gatewayReplies = [
      () => {
        put(typed, "m8");
        return new Response(JSON.stringify(toolAnswer(DRAFT)), { status: 200 });
      },
      toolAnswer(CHECKED),
    ];
    const raced = await summarize(env, TOKEN, { path: PATH });
    const racedText = stored();
    check(
      "a note edited while the model wrote keeps the edit, and still gets its summary",
      raced.body?.status === "written" && racedText.includes("typed during the summary") && summaryOf(racedText).includes("due October 15"),
    );

    const personal = meeting({ summary: "We agreed on Tuesday." });
    put(meeting(), "m9");
    gatewayReplies = [
      () => {
        put(personal, "m10");
        return new Response(JSON.stringify(toolAnswer(DRAFT)), { status: 200 });
      },
      toolAnswer(CHECKED),
    ];
    const overtaken = await summarize(env, TOKEN, { path: PATH });
    check("a summary somebody typed during the wait is left alone", overtaken.body?.status === "skipped" && stored() === personal);

    /* ---------------- tenancy ---------------- */

    s3.bucketFor("tenant-other-summary").set(PATH, { body: meeting(), etag: "o1" });
    bucket().delete(PATH);
    const before = gatewayCalls.length;
    const across = await summarize(env, TOKEN, { path: PATH });
    check(
      "a path that exists only in another workspace is not found, and that workspace is untouched",
      across.body?.status === "skipped" && gatewayCalls.length === before && s3.bucketFor("tenant-other-summary").get(PATH).body === meeting(),
    );
  } finally {
    globalThis.fetch = withStubs;
    restoreControlPlane();
    restoreS3();
  }
}
