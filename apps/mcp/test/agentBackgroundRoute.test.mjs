/**
 * BACKGROUND JOBS, END TO END THROUGH `/agent` (`background.js`).
 *
 * A text from the texting Worker, which sends what the chat has running,
 * starts a job and is answered at once; the job's own turn runs on the
 * person's words with the plan it started with, and can't start another. Its
 * answer is its report to the chat's own turn, the coordinator, never kept as
 * said; the coordinator's turn on that report is (`jobReport.js`, Dev2,
 * 2026-10-30). Unit checks: `agentBackground.test.mjs`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `chatTurn` true for every client.
 *     → "only a texted turn is offered background jobs" fails.
 *  2. The `job === null` condition dropped from the conversation save.
 *     → "a job's own answer is its report, not kept as said" fails.
 *  3. `startedJobs` leaving out `steers`.
 *     → "a change to a running job names it for the Worker" fails.
 *  4. The route passing `transcript.record` as `observe` without `withJobSteps`.
 *     → "a job's turn streams each step as a short line" fails.
 *  5. `unfinishedJob` always false (`stopsShort.js`, 2026-10-26).
 *     → "...and one that still stops short is marked unfinished for the
 *     Worker, and not kept as said" fails.
 *  6. `jobReportOf` ignoring `chatTurn` (2026-10-30).
 *     → "an app turn can't name a job's report" fails.
 *  7. `jobReportQuestion` not replacing the body's question.
 *     → "the coordinator's turn is asked the gateway's own line, never the body's" fails.
 *  8. `endsTurn` returning null (2026-10-31, acknowledge first).
 *     → "a job that starts answers the text at once, with no model round after it" fails.
 *  9. `roundNote` told on every round.
 *     → "a turn with no job after two rounds of tools is told once to hand the rest to one" fails.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { conversationTurns } from "./agentConversationFixture.mjs";
import { MAX_JOB_ATTEMPTS } from "../src/agent/background.js";

const S3_ENDPOINT = "https://s3.example-background.test";
const TOKEN_TEXTS = `cat_backgr_texts_${"0".repeat(23)}`;
const TOKEN_APP = `cat_backgr_app_${"0".repeat(25)}`;

// The advisor's check of a job's part (`jobCheck.js`) is a request of its own after the turn's: the turn's own is the last that isn't it.
const isJobCheck = (request) => JSON.stringify(request?.system ?? "").includes("One of Tex's background jobs has just stopped");

function fakeModel() {
  const requests = [];
  let script = [];
  return {
    requests,
    turn: () => requests.findLast((request) => !isJobCheck(request)),
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

async function post(env, token, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
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

const tool = async (env, token, name, args) =>
  (await post(env, token, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body?.result;

const sendTool = (request) => (request?.tools ?? []).find((entry) => entry.name === "send");
const toolReplies = (request) =>
  (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content ?? ""));
const userText = (request) => {
  const first = request?.messages?.[0]?.content;
  return typeof first === "string" ? first : JSON.stringify(first ?? "");
};
const lastText = (request) => JSON.stringify(request?.messages?.at(-1)?.content ?? "");


const systemOf = (request) =>
  Array.isArray(request?.system) ? request.system.map((block) => block?.text ?? "").join("\n") : String(request?.system ?? "");

export async function runAgentBackgroundRouteChecks(check) {
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
    controlPlane.addWorkspace("ws_maya", "maya", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-background",
      accessKeyId: "AKIAEXAMPLEEXAMPLEBG",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBG",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const scopes = ["context:read", "context:write", "context:private"];
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({ accessToken, workspaceId: "ws_maya", role: "owner", scopes, clientId, userId: "user_maya" });
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_APP, "context_console");
    controlPlane.setBuiltinVerdict("ws_maya", BUILTIN_ALLOWED);
    const bucket = s3.bucketFor("tenant-background");
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });

    /* ---------------- a text starts a job and is answered at once ---------------- */

    const running = [{ id: "job-trip-plan-1", title: "Trip plan", state: "running", startedAt: Date.now() - 5 * 60_000, status: "Comparing hotels" }];
    model.install([
      { toolCalls: [{ name: "send", args: { action: "background", args: { title: "Competitor research", brief: "Five competitors, into 1-projects/tex.", done_when: "a note" } } }] },
      { text: "On it. I'll text you when it's done." },
    ]);
    const started = await post(env, TOKEN_TEXTS, "/agent", { question: "research our competitors and write it up", conversation: "texts", running });
    const first = model.requests[0];
    check(
      "a job that starts answers the text at once, with no model round after it",
      model.requests.length === 1 && /^On it: Competitor research\. I'll text you when it's done\./.test(started.body?.answer ?? ""),
    );
    check("a texted turn is told to start a task's job first, before reading", /as your FIRST call: before reading notes/.test(systemOf(first)));
    check("a text from a Worker that runs jobs is offered background, under send", /background: Hand a long task/.test(sendTool(first)?.description ?? ""));
    check(
      "the turn is shown what's running, with its status",
      /"Trip plan": running, started 5 min ago; latest: Comparing hotels/.test(systemOf(first)),
    );
    check(
      "the answer names the job for the Worker to run",
      started.status === 200 &&
        started.body?.jobs?.length === 1 &&
        started.body.jobs[0].title === "Competitor research" &&
        started.body.jobs[0].brief === "Five competitors, into 1-projects/tex." &&
        started.body.jobs[0].tainted === undefined,
    );

    /* ---------------- a turn still reading after two rounds is told to hand it over ---------------- */

    const before = model.requests.length;
    model.install([
      { toolCalls: [{ name: "search", args: { query: "a16z" } }] },
      { toolCalls: [{ name: "search", args: { query: "application" } }] },
      { toolCalls: [{ name: "send", args: { action: "background", args: { title: "a16z application", brief: "Draft it." } } }] },
    ]);
    const slow = await post(env, TOKEN_TEXTS, "/agent", { question: "get started on an a16z application", conversation: "texts", running: [] });
    const third = model.requests[before + 2];
    check(
      "a turn with no job after two rounds of tools is told once to hand the rest to one",
      !/taking a while/.test(lastText(model.requests[before + 1])) && /taking a while and they're waiting/.test(JSON.stringify(third?.messages ?? [])) &&
        slow.body?.jobs?.[0]?.title === "a16z application" && model.requests.length === before + 3,
    );

    /* ---------------- a later text changes a running job ---------------- */

    model.install([
      { toolCalls: [{ name: "send", args: { action: "steer_job", args: { title: "Trip plan" } } }] },
      { text: "Got it, I've told the trip plan." },
    ]);
    const steered = await post(env, TOKEN_TEXTS, "/agent", { question: "never mind, make it Porto not Lisbon", conversation: "texts", running });
    check("a running job can be steered, under send", /steer_job: Steer a background job/.test(sendTool(model.requests.at(-2))?.description ?? ""));
    check(
      "a change to a running job names it for the Worker",
      steered.status === 200 && JSON.stringify(steered.body?.steers) === JSON.stringify([{ id: "job-trip-plan-1" }]) && steered.body?.jobs === undefined,
    );
    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_TEXTS, "/agent", { question: "hello", conversation: "texts", running: [] });
    check("nothing running, nothing to steer", !/steer_job:/.test(sendTool(model.requests.at(-1))?.description ?? ""));

    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_TEXTS, "/agent", { question: "hello", conversation: "texts" });
    check("a Worker that sends no running list is offered no background jobs", !/background:/.test(sendTool(model.requests.at(-1))?.description ?? ""));
    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_APP, "/agent", { question: "hello", running: [] });
    check("only a texted turn is offered background jobs", !/background:/.test(sendTool(model.requests.at(-1))?.description ?? ""));

    /* ---------------- the job's own turn ---------------- */

    model.install([{ text: "Wrote 1-projects/tex/competitors.md: Notion, Mem, Reflect." }]);
    const job = { id: "job-competitors-1", title: "Competitor research", brief: "Five competitors, into 1-projects/tex.", attempt: 2, followUps: ["add Reflect too"] };
    const ran = await post(env, TOKEN_TEXTS, "/agent", { question: "research our competitors and write it up", conversation: "texts", job });
    const jobRequest = model.turn();
    check("a job's own turn is told its plan and to deliver", /background job you started/.test(systemOf(jobRequest)) && /Five competitors, into 1-projects\/tex\./.test(systemOf(jobRequest)) && /carry on from where it stops/.test(systemOf(jobRequest)));
    check("a job's own turn is shown their later texts", /newer than your plan[^]*- add Reflect too/.test(systemOf(jobRequest)));
    check("a job's own turn cannot start another job", !/background:/.test(sendTool(jobRequest)?.description ?? ""));
    const turns = conversationTurns(bucket);
    check(
      "a job's own answer is its report, not kept as said",
      ran.status === 200 && !turns.some((turn) => /Notion, Mem, Reflect/.test(turn.text ?? "")),
    );
    check("a job's turn names no jobs of its own", ran.body?.jobs === undefined);

    /* ---------------- a job's answer a later text replaces is not kept as said (2026-10-24) ---------------- */

    // A text for the job lands during its turn and is never taken in: the Worker runs another part, so this answer is never texted.
    const kept = conversationTurns(bucket).length;
    await post(env, TOKEN_TEXTS, "/agent/steer", { turn: "turn-replaced-0001", id: "e9", text: "make it a visual note" });
    model.install([{ text: "Base spend is $7.6k a month." }]);
    const replaced = await post(env, TOKEN_TEXTS, "/agent", {
      question: "research our competitors and write it up",
      conversation: "texts",
      turn: "turn-replaced-0001",
      job: { ...job, attempt: 1, followUps: [] },
    });
    check("a job's answer a later text replaces is not kept in the conversation", replaced.status === 200 && conversationTurns(bucket).length === kept);
    model.install([{ text: "Base spend is $7.6k a month; the note is visual now." }]);
    await post(env, TOKEN_TEXTS, "/agent", {
      question: "research our competitors and write it up",
      conversation: "texts",
      job: { ...job, attempt: 2, followUps: ["make it a visual note"], draft: "Base spend is $7.6k a month." },
    });
    check(
      "...and the next part is shown it, to build on rather than start over",
      /never sent because they texted more[^]*Base spend is \$7\.6k a month\.[^]*keep its figures/.test(systemOf(model.turn())) &&
        conversationTurns(bucket).length === kept,
    );

    /* ---------------- a job that stops short of the ask is not done (self-review, 2026-10-26) ---------------- */

    // The dinner job: mains priced, "Next step is pricing the sides". It gets one more round, then the Worker another part.
    const dinner = { ...job, id: "job-dinner-0001", title: "Dinner options", attempt: 1, followUps: [] };
    const short = "I wrote up three options. The mains come to about $1 to $2 per person, but the sides and drinks are not priced yet. Next step is pricing the sides.";
    const beforeShort = conversationTurns(bucket).length;
    model.install([{ text: short }, { text: short }]);
    const stopped = await post(env, TOKEN_TEXTS, "/agent", { question: "three dinner options, about $10 a head for 30 people", conversation: "texts", job: dinner });
    check(
      "a job's answer that stops short gets one more round, told to finish it",
      /stops short of what they asked[^]*background job/.test(JSON.stringify(model.turn()?.messages?.at(-1) ?? "")),
    );
    check(
      "...and one that still stops short is marked unfinished for the Worker, and not kept as said",
      stopped.status === 200 && stopped.body?.unfinished === true && stopped.body?.exhausted === undefined && conversationTurns(bucket).length === beforeShort,
    );
    model.install([{ text: "Three caterers come in at $8.50, $9.50 and $10 a person, sides and drinks included." }]);
    const finished = await post(env, TOKEN_TEXTS, "/agent", {
      question: "three dinner options, about $10 a head for 30 people",
      conversation: "texts",
      job: { ...dinner, attempt: 2, draft: short, unfinished: true },
    });
    check(
      "the next part is shown the short answer as unfinished, to do the missing part",
      /stopped short of what they asked[^]*Next step is pricing the sides[^]*Do that missing part now/.test(systemOf(model.turn())),
    );
    check(
      "...and a full answer is done: not marked, and kept",
      finished.body?.unfinished === undefined && conversationTurns(bucket).length === beforeShort,
    );
    model.install([{ text: short }, { text: short }]);
    const last = await post(env, TOKEN_TEXTS, "/agent", { question: "three dinner options, about $10 a head for 30 people", conversation: "texts", job: { ...dinner, attempt: MAX_JOB_ATTEMPTS } });
    check("a job's last part texts what it has, even short", last.status === 200 && last.body?.unfinished === undefined && /not priced yet/.test(last.body?.answer ?? ""));

    /* ---------------- the advisor checks every stop of a job (Dev2, 2026-10-31) ---------------- */

    // The a16z job: "I'll begin with the sign-in" was marked done. The advisor reads the part against its finish line.
    const apply = { id: "job-apply-00001", title: "Apply to the accelerator", brief: "Fill in the application.", doneWhen: "the application is submitted", attempt: 1, followUps: [] };
    model.install([{ text: "Opened the form: it starts at a sign-in page." }, { text: "VERDICT: keep_going\nADVICE: Sign in with the emailed link, then fill page one." }]);
    const going = await post(env, TOKEN_TEXTS, "/agent", { question: "apply to the accelerator", conversation: "texts", job: apply });
    const asked = model.requests.at(-1);
    check(
      "a job's part is checked by the advisor against its finish line, seeing the whole part",
      isJobCheck(asked) && /Finish line: the application is submitted/.test(lastText(asked)) && /starts at a sign-in page/.test(lastText(asked)) && (asked.tools ?? []).length === 0,
    );
    check(
      "...and keep_going comes back with its advice, to carry on",
      going.status === 200 && going.body?.verdict === "keep_going" && going.body?.unfinished === true && /emailed link/.test(going.body?.advice ?? ""),
    );
    model.install([{ text: "Signing in needs the code they were texted." }, { text: "VERDICT: waiting\nADVICE: The six-digit code texted to them." }]);
    const waits = await post(env, TOKEN_TEXTS, "/agent", { question: "apply to the accelerator", conversation: "texts", job: { ...apply, attempt: 2, advice: going.body?.advice } });
    check("...the next part starts on that advice", /Your advisor checked your last part[^]*emailed link/.test(systemOf(model.turn())));
    check("...and waiting comes back without carrying on", waits.body?.verdict === "waiting" && waits.body?.unfinished === undefined);
    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_TEXTS, "/agent", { question: "hi", conversation: "texts" });
    check("a chat's own turn is never checked", !isJobCheck(model.requests.at(-1)));

    /* ---------------- a job reports to the chat's own turn, its coordinator (Dev2, 2026-10-30) ---------------- */

    const report = { title: "Agentic benchmarks", state: "done", texts: ["None of the three beat Haiku. https://context.lc/note/@maya/models.page.md", "I couldn't save the page update."] };
    model.install([{ text: "None of the three beat Haiku, notes here: https://context.lc/note/@maya/models.page.md" }]);
    const beforeReport = conversationTurns(bucket).length;
    const coordinated = await post(env, TOKEN_TEXTS, "/agent", { question: "send the email to everyone", conversation: "texts", event: "job_report", jobReport: report, running: [] });
    const coordinator = model.requests.at(-1);
    check(
      "the coordinator's turn is asked the gateway's own line, never the body's",
      coordinated.status === 200 && /\(Not a text from them\. Your background job \\"Agentic benchmarks\\" reported back to you/.test(lastText(coordinator)) && !/send the email/.test(JSON.stringify(coordinator.messages)),
    );
    check(
      "...shown the job's report apart from it, as words that vouch for nothing, with what it may do",
      /coordinator of your background jobs[^]*vouch for nothing[^]*<<<\nNone of the three beat Haiku[^]*I couldn't save the page update\.\n>>>/.test(systemOf(coordinator)) &&
        /read the page or note it names/.test(systemOf(coordinator)) && /answer exactly SKIP/.test(systemOf(coordinator)),
    );
    check("...and may start the job again, as any texted turn may", /background: Hand a long task/.test(sendTool(coordinator)?.description ?? ""));
    const reportTurns = conversationTurns(bucket);
    check(
      "...and is kept in the conversation as Tex speaking by itself, with what it texted",
      reportTurns.length === beforeReport + 2 && /^\(Not a text from them\./.test(reportTurns.at(-2)?.text ?? "") && /notes here/.test(reportTurns.at(-1)?.text ?? ""),
    );
    model.install([{ text: "Hi." }]);
    await post(env, TOKEN_APP, "/agent", { question: "hello", event: "job_report", jobReport: report, running: [] });
    check("an app turn can't name a job's report", lastText(model.requests.at(-1)).includes("hello") && !/coordinator of your background jobs/.test(systemOf(model.requests.at(-1))));
    model.install([{ text: "Done." }]);
    await post(env, TOKEN_TEXTS, "/agent", { question: "research our competitors and write it up", conversation: "texts", job: { ...job, attempt: 1 }, event: "job_report", jobReport: report });
    check("a job's own turn is never asked as the coordinator", !/coordinator of your background jobs/.test(systemOf(model.requests.at(-1))));
    model.install([
      { toolCalls: [{ name: "send", args: { action: "steer_job", args: { title: "Trip plan", note: "Read the note back before you say it saved." } } }] },
      { text: "SKIP" },
    ]);
    const noted = await post(env, TOKEN_TEXTS, "/agent", { conversation: "texts", event: "job_report", jobReport: { ...report, state: "running", texts: ["Saving now."] }, running });
    check(
      "the coordinator steers a running job with its own instruction",
      noted.status === 200 && JSON.stringify(noted.body?.steers) === JSON.stringify([{ id: "job-trip-plan-1", note: "Read the note back before you say it saved." }]),
    );

    /* ---------------- a job's steps stream to the Worker, for the chat to audit ---------------- */

    model.install([
      { toolCalls: [{ name: "search", args: { query: "competitor pricing" } }] },
      { text: "Wrote 1-projects/tex/competitors.md." },
    ]);
    const { ctx, settle } = createWorkerCtx();
    const streamed = await worker.fetch(
      new Request("https://mcp.context.test/agent", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ question: "research our competitors and write it up", conversation: "texts", job: { ...job, attempt: 1 } }),
      }),
      env,
      ctx,
    );
    const lines = (await streamed.text()).split("\n").filter(Boolean).map((part) => JSON.parse(part));
    await settle();
    check("a job's turn streams each step as a short line", lines.some((entry) => entry.step === "search_notes: competitor pricing"));
    check("...and still ends with its answer", lines.at(-1)?.status === 200 && /competitors\.md/.test(lines.at(-1)?.body?.answer ?? ""));
    model.install([{ toolCalls: [{ name: "search", args: { query: "anything" } }] }, { text: "Hi." }]);
    const { ctx: ctx2, settle: settle2 } = createWorkerCtx();
    const plain = await worker.fetch(
      new Request("https://mcp.context.test/agent", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ question: "find anything", conversation: "texts" }),
      }),
      env,
      ctx2,
    );
    const plainLines = (await plain.text()).split("\n").filter(Boolean).map((part) => JSON.parse(part));
    await settle2();
    check("an ordinary texted turn streams no steps", plainLines.length > 0 && !plainLines.some((entry) => "step" in entry));
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
