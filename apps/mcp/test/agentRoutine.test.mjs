/**
 * A ROUTINE'S TURN, END TO END THROUGH `/agent`.
 *
 * A note under `routines/<schedule>/` is carried out on its schedule as the
 * person who wrote it (`docs/decisions/routines.md`). The control plane says
 * when; these checks are the gateway's half:
 *
 *  - only a routine's own connection runs one, and that connection runs
 *    nothing else;
 *  - the routine is re-read through the writer's own access at the moment it
 *    runs, so one they can no longer see, or one that is paused, never reaches
 *    a model;
 *  - the answer is kept beside the routine in the customer's bucket, and the
 *    next run is told what the last one said;
 *  - "nothing to say" and "the until: came true" come back as outcomes, not
 *    as texts.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. The route accepting `routine` from any grant (`runner !==` check
 *     removed). → `a routine is refused from any other connection` fails.
 *  2. The route loading the routine through the raw `callTool(name, args,
 *     store, "private")` instead of `callToolForSession` — the runner reaching
 *     past its writer's clamp. → `a routine its writer can no longer see does
 *     not run` fails.
 *  3. The paused check moved below `openProvider`. → `a paused routine costs
 *     no turn` fails.
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  createControlPlaneStub,
  createS3Backend,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
} from "./controlPlaneStub.mjs";
import { MAX_RUNS_KEPT, routineBody, runOutcome } from "../src/agent/routine.js";

const S3_ENDPOINT = "https://s3.example-routine.test";
const TOKEN_RUNNER = `cat_routine_runner_${"0".repeat(21)}`;
const TOKEN_RUNNER_TEAM = `cat_routine_team_${"0".repeat(23)}`;
const TOKEN_CLIENT = `cat_routine_client_${"0".repeat(21)}`;
const API_KEY = "zarquon-plumbago-routine-not-a-real-key";

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  routines/daily/team: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const BRIEF =
  "---\nat: 7:30 am\nsend: both\nto: @sayo\ntimezone: America/New_York\n---\n" +
  "Text me the three things due today from 1-projects.\n";

function fakeModel() {
  const requests = [];
  let script = [];
  return {
    requests,
    install(replies) {
      script = [...replies];
    },
    async handle(url, init) {
      requests.push(JSON.parse(init.body));
      const next = script.shift();
      if (!next) throw new Error("fake model: the script ran out");
      if (next.status) return new Response("{}", { status: next.status });
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: next.text }], stop_reason: "end_turn" }),
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

export async function runAgentRoutineChecks(check) {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const model = fakeModel();
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.anthropic.com")) return model.handle(url, init);
    return withStubs(input, init);
  };

  try {
    controlPlane.addWorkspace("ws_routine", "routinely", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-routine",
      accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId, scopes) =>
      controlPlane.addGrant({ accessToken, workspaceId: "ws_routine", role: "owner", scopes, clientId, userId: "user_writer" });
    await grant(TOKEN_RUNNER, "context_routines", ["context:read", "context:write", "context:private"]);
    // The writer's access narrowed to `team`: a private routine is out of reach.
    await grant(TOKEN_RUNNER_TEAM, "context_routines", ["context:read", "context:write"]);
    await grant(TOKEN_CLIENT, "mcp_client_routine", ["context:read", "context:write", "context:private"]);
    controlPlane.connectProvider("ws_routine", "anthropic", API_KEY);

    const bucket = s3.bucketFor("tenant-routine");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "g0" });
    bucket.set("routines/daily/morning-brief.md", { body: BRIEF, etag: "g1" });
    bucket.set("routines/daily/quiet.md", { body: "---\npaused: yes\n---\nCheck the inbox.\n", etag: "g2" });
    bucket.set("routines/daily/team/standup.md", { body: "Say good morning.\n", etag: "g3" });
    bucket.set("routines/every-5-minutes/landed.md", {
      body: "---\nuntil: the parcel has landed\n---\nIs the parcel here yet?\n",
      etag: "g4",
    });
    bucket.set("1-projects/notes.md", { body: "# Notes\n", etag: "g5" });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
    const runsOf = (name) => {
      const object = bucket.get(`.context/agent/routines/${name}.json`);
      return object ? JSON.parse(object.body).runs : [];
    };

    /* ---------------- who may run one ---------------- */

    let before = model.requests.length;
    const stranger = await ask(env, TOKEN_CLIENT, { routine: { path: "routines/daily/morning-brief.md" } });
    check(
      "a routine is refused from any other connection, before a model is called",
      stranger.status === 403 && model.requests.length === before,
    );
    const freeQuestion = await ask(env, TOKEN_RUNNER, { question: "What's in my notes?" });
    check(
      "a routine's connection answers no free questions",
      freeQuestion.status === 400 && model.requests.length === before,
    );
    const outside = await ask(env, TOKEN_RUNNER, { routine: { path: "1-projects/notes.md" } });
    check(
      "only a note in a schedule folder is a routine",
      outside.status === 400 && outside.body?.error === "not_a_routine" && model.requests.length === before,
    );
    const missing = await ask(env, TOKEN_RUNNER, { routine: { path: "routines/daily/deleted.md" } });
    check("a deleted routine does not run", missing.status === 404 && missing.body?.error === "routine_gone");
    const unseen = await ask(env, TOKEN_RUNNER_TEAM, { routine: { path: "routines/daily/morning-brief.md" } });
    check(
      "a routine its writer can no longer see does not run",
      unseen.status === 404 && unseen.body?.error === "routine_gone" && model.requests.length === before,
    );
    const paused = await ask(env, TOKEN_RUNNER, { routine: { path: "routines/daily/quiet.md" } });
    check(
      "a paused routine costs no turn",
      paused.status === 200 && paused.body?.outcome === "paused" && model.requests.length === before,
    );

    /* ---------------- a run ---------------- */

    model.install([{ text: "1. Ship the map. 2. Call Sayo. 3. Pay the invoice." }]);
    const first = await ask(env, TOKEN_RUNNER, {
      routine: { path: "routines/daily/morning-brief.md", timeZone: "Europe/London" },
      conversation: "texts",
    });
    const sent = model.requests.at(-1);
    check(
      "a routine runs and says what to send, and to whom",
      first.status === 200 &&
        first.body?.outcome === "answered" &&
        first.body?.skipped === false &&
        first.body?.answer.startsWith("1. Ship the map") &&
        first.body?.send === "both" &&
        JSON.stringify(first.body?.to) === JSON.stringify(["sayo"]),
    );
    check(
      "the model is told it is a scheduled routine, with the schedule and the routine's own words",
      userText(sent).includes("scheduled routine") &&
        userText(sent).includes("Every day at 7:30 am") &&
        userText(sent).includes("Text me the three things due today"),
    );
    check(
      "the file's own time zone wins over the account's",
      userText(sent).includes("(America/New_York)") && !userText(sent).includes("Europe/London"),
    );
    check("front matter is not handed over as instructions", !userText(sent).includes("send: both"));
    check(
      "a routine's answer is written as a text",
      JSON.stringify(sent?.system ?? "").includes("No Markdown"),
    );
    check(
      "the run is kept beside the routine, in Context's own space",
      runsOf("daily/morning-brief").length === 1 &&
        runsOf("daily/morning-brief")[0].outcome === "answered" &&
        runsOf("daily/morning-brief")[0].text.startsWith("1. Ship the map"),
    );
    check(
      "a routine never writes into the texting conversation",
      bucket.get(".context/agent/conversations/texts.json") === undefined,
    );

    model.install([{ text: "SKIP" }]);
    const second = await ask(env, TOKEN_RUNNER, { routine: { path: "routines/daily/morning-brief.md" } });
    check(
      "the next run is told what the last one said",
      userText(model.requests.at(-1)).includes("Last time") &&
        userText(model.requests.at(-1)).includes("Ship the map"),
    );
    check(
      "nothing to say is an outcome, not a text",
      second.body?.outcome === "skipped" && second.body?.skipped === true && second.body?.answer === "",
    );
    check("a skipped run is still kept", runsOf("daily/morning-brief").at(-1)?.outcome === "skipped");

    model.install([{ text: "DONE: It landed at 3:12 pm." }]);
    const done = await ask(env, TOKEN_RUNNER, { routine: { path: "routines/every-5-minutes/landed.md" } });
    check(
      "a routine whose until: came true says so, and says what happened",
      userText(model.requests.at(-1)).includes("the parcel has landed") &&
        done.body?.outcome === "finished" &&
        done.body?.answer === "It landed at 3:12 pm.",
    );

    model.install([{ status: 500 }]);
    const failed = await ask(env, TOKEN_RUNNER, { routine: { path: "routines/daily/morning-brief.md" } });
    check(
      "a run whose model failed is kept as failed",
      failed.status === 502 && runsOf("daily/morning-brief").at(-1)?.outcome === "failed",
    );

    /* ---------------- the pieces ---------------- */

    check(
      "SKIP is read loosely, and only on its own",
      runOutcome(" skip. ").outcome === "skipped" &&
        runOutcome("").outcome === "skipped" &&
        runOutcome("Skip the meeting today, it moved.").outcome === "answered",
    );
    check(
      "the body is what is below the front matter",
      routineBody("---\nat: 9am\n---\nDo it.\n") === "Do it." &&
        routineBody("Do it.") === "Do it." &&
        routineBody("---\nunclosed\nDo it.") === "---\nunclosed\nDo it.",
    );
    check("history is bounded", MAX_RUNS_KEPT === 20);
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
