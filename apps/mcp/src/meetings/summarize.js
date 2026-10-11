/**
 * `POST /meetings/summary` — write a meeting note's `## Summary`.
 *
 * The app asks for this when somebody opens a meeting note that has none yet,
 * and again when they press Redo summary. Everything that decides what the
 * summary says lives in `packages/meetings/src/summary.js`; this file is the
 * plumbing around it, and three things about that plumbing are deliberate:
 *
 *  - **The note is read and written through `toolReadNote` and `toolWriteNote`.**
 *    Visibility, encryption, the collaboration merge, the activity line and the
 *    live update to an open editor are therefore the same as any agent's edit,
 *    and the write is conditional on the etag it read. A note that changed
 *    while the model was writing is read again and only the summary section is
 *    replaced, so somebody typing in `## My notes` loses nothing.
 *  - **The control plane decides whether a summary may run, before any model
 *    call**, and counts it (`apps/convex/functions/meetingSummary.ts`). It is
 *    told token counts afterwards and never a word of the meeting.
 *  - **A summary a person typed is never replaced on its own.** Only an empty,
 *    waiting or failed section is filled without `force`, and `force` is the
 *    Redo button, which a person pressed.
 *
 * The model is Haiku through the deployment's AI gateway, asked twice: once to
 * write and once to check the draft against the transcript. A check that fails
 * keeps the draft; a write that fails leaves a line saying so, which the next
 * open retries.
 */

import {
  MAX_INSTRUCTION_CHARS,
  SUMMARY_FAILED,
  SUMMARY_TOOL,
  SUMMARY_TOO_SHORT,
  MIN_TRANSCRIPT_WORDS,
  buildCheckRequest,
  buildSummaryRequest,
  isStillRecording,
  needsAutomaticSummary,
  readSummaryOutput,
  renderSummary,
  replaceSummary,
  summaryState,
  transcriptWords,
  waitingSummary,
} from "../../../../packages/meetings/src/summary.js";
import { DEFAULT_GATEWAY_MODEL } from "../agent/builtin.js";
import { aiGatewayConfig, gatewayMetadata, requestViaGateway } from "../agent/aiGateway.js";
import { loadPrivacyState } from "../privacy/state.js";
import { toolReadNote } from "../tools/notes/read.js";
import { toolWriteNote } from "../tools/notes/write.js";

/** The route, beside the workspace selector: `/@team/meetings/summary` is the team's. */
export const MEETING_SUMMARY_PATH = "/meetings/summary";

/** Room for one long answer: four paragraphs, two tables, a chart and the tasks. */
const SUMMARY_OUTPUT_TOKENS = 4096;

/** The request body is a path and a sentence; anything bigger is not this route's. */
const MAX_BODY_BYTES = 4096;

const ACTIVITY_LINE = "summarized this meeting";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/** Header fields and text out of `read_note`'s answer; the shape `comment.js` reads. */
function parseRead(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  const split = text.indexOf("\n\n");
  if (split === -1) return null;
  const fields = {};
  for (const line of text.slice(0, split).split("\n")) {
    const colon = line.indexOf(": ");
    if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return { fields, body: text.slice(split + 2) };
}

async function readMeeting(store, scope, privacy, path) {
  const read = await toolReadNote(store, scope, privacy.rules, privacy.overrides, path);
  if (read?.isError) return null;
  const parsed = parseRead(read);
  if (!parsed || !parsed.fields.etag || parsed.fields.kind === "drawing") return null;
  return { path: parsed.fields.path || path, etag: parsed.fields.etag, text: parsed.body };
}

/**
 * Replace the summary section and write, retrying once against a note that
 * changed meanwhile. Without `force`, a section somebody filled in during the
 * wait is left alone.
 */
async function writeSummary(store, scope, privacy, meeting, body, { force }) {
  let current = meeting;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      current = await readMeeting(store, scope, privacy, current.path);
      if (!current) return "failed";
      const state = summaryState(current.text);
      if (state === "not_meeting") return "skipped";
      if (!force && state === "written") return "skipped";
    }
    const next = replaceSummary(current.text, body);
    if (next === null) return "skipped";
    if (next === current.text) return "written";
    const written = await toolWriteNote(store, scope, privacy.rules, privacy.overrides, {
      path: current.path,
      content: next,
      expected_etag: current.etag,
      summary: ACTIVITY_LINE,
    });
    if (!written?.isError) return "written";
    if (!/^conflict:/.test(written?.content?.[0]?.text ?? "")) return "failed";
  }
  return "conflict";
}

/** The date the meeting started, which is what "Monday" in it is relative to. */
function meetingDay(markdown, now) {
  const started = /^started:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(String(markdown).split("\n---")[0] ?? "");
  return started ? started[1] : new Date(now()).toISOString().slice(0, 10);
}

function addUsage(total, usage) {
  total.input += usage?.input ?? 0;
  total.output += usage?.output ?? 0;
  total.cacheRead += usage?.cacheRead ?? 0;
  total.cacheWrite += usage?.cacheWrite ?? 0;
}

/** One forced tool call; the tool's arguments as the renderer reads them, or `null`. */
async function askModel(request, config, { metadata, fetchImpl, now }, usage) {
  const answer = await requestViaGateway(
    {
      model: DEFAULT_GATEWAY_MODEL,
      system: request.system,
      messages: [{ role: "user", text: request.user }],
      tools: [SUMMARY_TOOL],
      toolChoice: SUMMARY_TOOL.name,
      maxTokens: SUMMARY_OUTPUT_TOKENS,
    },
    config,
    { metadata, fetchImpl, now },
  );
  addUsage(usage, answer.usage);
  const call = answer.toolCalls.find((candidate) => candidate.name === SUMMARY_TOOL.name);
  return call ? readSummaryOutput(call.args) : null;
}

/**
 * Write and check. `null` when no usable summary came back; a failed check
 * keeps the draft, since a summary that was not double-checked is still better
 * than none.
 */
async function draftSummary(markdown, { instruction, today }, config, options, usage) {
  const draft = await askModel(buildSummaryRequest(markdown, { instruction, today }), config, options, usage);
  if (!draft) return null;
  try {
    return (await askModel(buildCheckRequest(markdown, draft, { today }), config, options, usage)) ?? draft;
  } catch {
    return draft;
  }
}

/**
 * Summarize one meeting note.
 *
 * @param {object} store the request's store, actor attached
 * @param {object} session the resolved session
 * @param {{path: string, instruction?: string, force?: boolean}} request
 * @param {{controlPlane: object, env: object, fetchImpl?: Function, now?: () => number}} deps
 * @returns {Promise<"written"|"skipped"|"recording"|"waiting"|"too_short"|"unavailable"|"failed"|"conflict">}
 */
export async function summarizeMeetingNote(store, session, request, deps) {
  const now = deps.now || Date.now;
  const privacy = await loadPrivacyState(store);
  if (privacy.error) return "failed";
  const scope = session.scope;

  const meeting = await readMeeting(store, scope, privacy, request.path);
  if (!meeting) return "skipped";
  const state = summaryState(meeting.text);
  if (state === "not_meeting") return "skipped";
  if (!request.force && !needsAutomaticSummary(meeting.text)) {
    // A short meeting gets its one line once, without a model call.
    if (state === "placeholder" && !isStillRecording(meeting.text) && transcriptWords(meeting.text) < MIN_TRANSCRIPT_WORDS) {
      return writeSummary(store, scope, privacy, meeting, SUMMARY_TOO_SHORT, { force: false }).then((done) =>
        done === "written" ? "too_short" : done,
      );
    }
    return isStillRecording(meeting.text) ? "recording" : "skipped";
  }
  if (transcriptWords(meeting.text) < MIN_TRANSCRIPT_WORDS) {
    const done = await writeSummary(store, scope, privacy, meeting, SUMMARY_TOO_SHORT, { force: true });
    return done === "written" ? "too_short" : done;
  }

  const config = aiGatewayConfig(deps.env);
  if (!config) return "unavailable";
  const verdict = await deps.controlPlane.startMeetingSummary(session.accessToken, session.workspaceId);
  if (!verdict) return "unavailable";
  if (!verdict.allowed) {
    if (verdict.reason !== "daily_cap") return "unavailable";
    // Only a section with nothing of value in it learns about the wait; a
    // Redo over a real summary leaves that summary where it is.
    if (state === "placeholder" || state === "failed") {
      await writeSummary(store, scope, privacy, meeting, waitingSummary({ paying: verdict.paying === true }), { force: false });
    }
    return "waiting";
  }

  const started = now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const options = {
    metadata: gatewayMetadata({ feature: "meetingSummary", workspace: session.workspaceId }),
    fetchImpl: deps.fetchImpl,
    now,
  };
  let output = null;
  try {
    output = await draftSummary(
      meeting.text,
      { instruction: typeof request.instruction === "string" ? request.instruction : undefined, today: meetingDay(meeting.text, now) },
      config,
      options,
      usage,
    );
  } catch {
    output = null;
  }

  const report = () =>
    deps.controlPlane
      .recordMeetingSummaryUsage(session.accessToken, session.workspaceId, {
        ...usage,
        model: DEFAULT_GATEWAY_MODEL,
        failed: output === null,
        ms: Math.max(0, now() - started),
      })
      .catch(() => {});

  if (!output) {
    await report();
    // A Redo that failed keeps what was there; an empty section says it failed.
    if (state !== "written" && state !== "too_short") {
      await writeSummary(store, scope, privacy, meeting, SUMMARY_FAILED, { force: false });
    }
    return "failed";
  }
  const done = await writeSummary(store, scope, privacy, meeting, renderSummary(output), { force: request.force === true });
  await report();
  return done;
}

/**
 * The route. Answers `200 {status}` for every outcome a person could cause,
 * so the app reads one field; `400` only for a body no app would send.
 */
export async function handleMeetingSummary(request, store, session, deps) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "invalid_request" }, 400);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_request" }, 400);
  const { path, instruction, force } = body;
  if (typeof path !== "string" || path === "" || path.length > 1024) return json({ error: "invalid_request" }, 400);
  if (instruction !== undefined && (typeof instruction !== "string" || instruction.length > MAX_INSTRUCTION_CHARS * 4)) {
    return json({ error: "invalid_request" }, 400);
  }
  if (force !== undefined && typeof force !== "boolean") return json({ error: "invalid_request" }, 400);

  const work = summarizeMeetingNote(store, session, { path, instruction, force: force === true }, deps);
  // The summary takes a minute; a person who closes the note mid-way still
  // gets it, written into the note for next time.
  if (typeof store.defer === "function") store.defer(work.catch(() => {}));
  const status = await work.catch(() => "failed");
  return json({ status });
}
