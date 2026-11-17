/**
 * TURNS NOBODY TEXTED, IN THE BENCH'S WORLD (Dev set, 2026-11-17: seven Front door tests start at a check-in or a
 * routine). A check-in and a routine run each come in on their own client's grant, over the person's own workspace,
 * as in production (`heartbeat.js` HEARTBEAT_CLIENT_ID, `routine.js` ROUTINES_CLIENT_ID), through the real `/agent`.
 * Their answers are shaped as a texted turn's (`world.text`), so `run.mjs` `converse` and the judge read them alike.
 */
import { HEARTBEAT_CLIENT_ID } from "../src/agent/heartbeat.js";
import { ROUTINES_CLIENT_ID } from "../src/agent/routine.js";
import { createWorkerCtx } from "../test/workerCtx.mjs";
import { realNow } from "./clock.mjs";

/** The check-in and routine grants for `person`'s own workspace: `{ checkin, routine }` tokens. */
export async function startGrants(controlPlane, { person, workspaceId, userId }) {
  const tokens = {};
  for (const [kind, clientId] of [["checkin", HEARTBEAT_CLIENT_ID], ["routine", ROUTINES_CLIENT_ID]]) {
    tokens[kind] = `cat_${kind}_${String(person).toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
    await controlPlane.addGrant({
      workspaceId,
      role: "owner",
      userId,
      accessToken: tokens[kind],
      scopes: ["context:read", "context:write", "context:private"],
      clientId,
      alsoMemberOf: [{ workspaceId: "ws_pinned", role: "member" }],
    });
  }
  return tokens;
}

/** One `/agent` call with `token`'s grant: its status, body, time and the model's usage. */
export async function startCall({ worker, env, token, body, controlPlane }) {
  const { ctx, settle } = createWorkerCtx();
  const started = realNow();
  const response = await worker.fetch(new Request("https://mcp.bench.invalid/agent", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
  const answer = await response.json().catch(() => null);
  await settle();
  return { status: response.status, body: answer, ms: realNow() - started, usage: controlPlane.builtinReports.at(-1) ?? {} };
}

/** One check-in looking back an hour: what it would text, or its quiet outcome. */
export async function checkInTurn(call) {
  return startedTurn(await call({ heartbeat: { timeZone: "UTC", since: Date.now() - 60 * 60_000 } }), (body) => (body?.outcome === "speak" ? body.answer : ""));
}

/** One run of the routine at `path`, as the routine runner asks: what it would text, or its quiet outcome. */
export async function routineTurn(path, call) {
  return startedTurn(await call({ routine: { path, timeZone: "UTC" } }), (body) => (body?.skipped ? "" : body?.answer));
}

/** An answer shaped as a turn is: `said` picks what it would text; a quiet one names its outcome. */
export function startedTurn(got, said) {
  const ok = got.status === 200 && got.body !== null;
  const text = ok ? String(said(got.body) ?? "") : "";
  return {
    ok,
    answer: text === "" ? `(stayed quiet: ${String(got.body?.outcome ?? got.body?.reason ?? "nothing texted")})` : text,
    error: ok ? null : String(got.body?.error ?? `status ${got.status}`),
    ms: got.ms,
    model: got.usage.model ?? null,
    tools: [],
    jobs: [],
    usage: { input: got.usage.inputTokens ?? 0, output: got.usage.outputTokens ?? 0, cacheRead: got.usage.cacheReadTokens ?? 0, cacheWrite: got.usage.cacheWriteTokens ?? 0 },
  };
}

/** An email arriving now (`{ from, subject, body }`) in the mailbox at `address`, as the bench's Gmail keeps one (`mailbox.mjs`). */
export function arrivedEmail(email, address, n) {
  const id = `arrived${n}`;
  const body = String(email.body ?? "");
  return { address, id, threadId: id, date: new Date(Date.now() - 5 * 60_000).toISOString(), from: String(email.from), to: address, subject: String(email.subject), body, attachments: [], snippet: body.replace(/\s+/g, " ").slice(0, 140) };
}

/**
 * One housekeeping run's answer, shaped as a turn is: the line it would text and the log it wrote (`read` reads the log
 * through the gateway as the person's own client).
 */
export async function houseTurn(got, read) {
  const body = got.body;
  const log = typeof body?.log === "string" ? (await read(body.log))?.body ?? "" : "";
  return {
    ok: got.status === 200 && typeof body?.outcome === "string",
    answer: [body?.line || `(${body?.outcome ?? "no outcome"}: nothing to text)`, log].filter(Boolean).join("\n\n"),
    asked: 0,
    error: got.status === 200 ? null : String(body?.error ?? `status ${got.status}`),
    ms: got.ms,
    model: got.usage.model ?? null,
    tools: [],
    usage: { input: got.usage.inputTokens ?? 0, output: got.usage.outputTokens ?? 0, cacheRead: got.usage.cacheReadTokens ?? 0, cacheWrite: got.usage.cacheWriteTokens ?? 0 },
  };
}
