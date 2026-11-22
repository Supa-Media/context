/**
 * RUN A CHECK-IN NOW, IN A TEST CHAT (Dev2, 2026-11-22: "every PR has its own sandbox that you can test on ... whenever
 * there's a change you need to make, but there's a capability gap, let's fix that capability gap").
 *
 * `checkin` on a test chat of the caller's own 1:1 (`route.js`): Tex's check-in (`agent/heartbeat.js`
 * `handleHeartbeat`) runs on the test chat's draft, over the copy-on-write sandbox of their workspace, exactly as the
 * check-in client's `/agent` call runs it. Its reads are real (their mail, calendar, notes); its writes (the check-in's
 * log, notes) land in the test copy; what it would text is Tex's row, never sent. The run is a row like a text's, every
 * step on its card, so a draft that wires a check-in step (a Quiet check, a Research step) can be tried before it ships.
 */

import { json } from "../fromGateway/http_responses.js";
import { HEARTBEAT_CLIENT_ID, handleHeartbeat } from "../fromGateway/agent_heartbeat.js";
import { createControlPlane } from "../fromGateway/controlPlane.js";
import { attachContextOpener, onceEach } from "../fromGateway/http_contextOpener.js";
import { attachPinnedDoors } from "../fromGateway/http_pinnedDoors.js";
import { decorateRequestStore } from "../fromGateway/http_requestStore.js";
import { attachLinkCalls } from "../fromGateway/http_routing.js";
import { PINNED_CONTEXT_NAME } from "../fromGateway/orient_globalNote.js";
import { sessionFromPayload, storeForSession } from "../fromGateway/session.js";
import { sandboxEnvOf } from "../fromGateway/labSandbox_policy.js";
import { callSandbox, sandboxStub } from "./object.js";
import { sandboxNamespace } from "./wire.js";
import { RUNNING_STALE_MS, sandboxGate } from "./harness.js";
import { fitSteps } from "./steps.js";

/** How far back a check-in looks when the caller names nothing, and the most it may. */
export const DEFAULT_HOURS = 6;
export const MAX_HOURS = 72;

/** The hours a check-in looks back over: a whole number from 1 to `MAX_HOURS`, `DEFAULT_HOURS` when none; null when bad. */
export function hoursOf(input) {
  const hours = input?.hours ?? DEFAULT_HOURS;
  return Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS ? hours : null;
}

/** What Tex's row says of a check-in that texted nothing, or failed. */
export function quietLine(body, status) {
  if (status >= 400) return "";
  return `(stayed quiet: ${String(body?.outcome ?? body?.reason ?? "nothing to text")})`;
}

/**
 * The route's checks, then the run. A 1:1 of the caller's own only: a check-in is a person's, and a group's look is
 * another path. Counts as a test text. Waits for the run and answers it.
 */
export async function checkInTestChat({ env, controlPlane, token, who, stub, origin, graph, helpers }, state, input) {
  const { draftConfig, refused, view, newIds, DAILY_SENDS } = helpers;
  const about = state.meta.chat;
  if (about.kind !== "one" || about.shared === true) return refused(400, "A check-in runs in a test chat of your own 1:1 with Tex: open one with source chat and no chatId.");
  const hours = hoursOf(input);
  if (hours === null) return refused(400, `hours is a whole number from 1 to ${MAX_HOURS}`);
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const drafted = await draftConfig(controlPlane, token, about.versionId, graph, about.drawn === true ? about.config : undefined);
  if (drafted.error) return refused(...drafted.error);
  const day = new Date().toISOString().slice(0, 10);
  const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `sends:${day}`, max: DAILY_SENDS });
  if (!counted.ok) return refused(429, `${DAILY_SENDS} test texts a day: try again tomorrow`);
  const answer = await controlPlane.labSandbox(token, "session", { chat: about.chat });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "This chat is no longer yours to test in.");
  const { at, eid, id } = newIds();
  const row = { id, eid, who: "Lab", text: `Run a check-in now (last ${hours} h)`, at, prod: false, checkin: hours };
  const claimed = await callSandbox(stub, "claim", { msgId: row.id, staleMs: RUNNING_STALE_MS });
  if (!claimed.ok) return refused(409, "a test text is still running: wait for its reply");
  try {
    await callSandbox(stub, "row.add", { row });
  } catch (error) {
    await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
    throw error;
  }
  const result = await runCheckInInTestChat({ env, stub, about, row, payload: answer.session, token, config: drafted.config ?? null, origin, hours });
  return json({ msgId: row.id, ...result });
}

/**
 * The store and session a check-in reads and writes through, opened as a texted turn's are (`chatRun.js`, `nightly.js`).
 */
export async function openCheckInStore({ env, controlPlane, payload, token, origin, gate, request }) {
  const session = sessionFromPayload(payload, null, token);
  Object.defineProperty(session, "labSandbox", { value: gate, enumerable: false });
  const store = await storeForSession(session, env, controlPlane);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  decorateRequestStore(store, { session, env, controlPlane, ctx, request, origin });
  const openOnce = onceEach((target) => storeForSession(target, env, controlPlane));
  attachContextOpener(store, session, { env, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
  attachPinnedDoors(store, session, (sibling) => storeForSession(sibling, env, controlPlane), (o, sibling) => attachLinkCalls(o, sibling, controlPlane, env));
  return { store, session };
}

/**
 * The check-in in a test chat: the check-in client's `/agent` call, on the sandbox's env (so `texConfigOf` reads the
 * draft and every write stays in the test copy), as the check-in client. `row` is already added and claimed.
 */
export async function runCheckInInTestChat({ env, stub, about, row, payload, token, config, origin, hours, now = Date.now, open = openCheckInStore, heartbeat = handleHeartbeat }) {
  const started = now();
  const gate = sandboxGate(stub, about, row.id, { config, arrivedAt: row.at ?? started, now });
  gate.groups = null;
  gate.noNotes = false;
  const sandboxEnv = sandboxEnvOf(env, { gate, workspaces: sandboxNamespace(env.WORKSPACE_STORE, gate), tex: sandboxNamespace(env.TEX_STORE, gate) });
  const controlPlane = createControlPlane(sandboxEnv);
  const replyId = `${row.id}r`;
  const timeZone = about.timeZone ?? payload?.timeZone ?? "UTC";
  let body = null;
  let status = 500;
  try {
    const request = new Request(`${origin}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ heartbeat: { timeZone, since: started - hours * 3_600_000 } }) });
    // As the check-in client: `handleHeartbeat` answers only that client, and its grant is what a real check-in holds.
    const { store, session } = await open({ env: sandboxEnv, controlPlane, payload: { ...payload, clientId: HEARTBEAT_CLIENT_ID }, token, origin, gate, request });
    const response = await heartbeat(request, sandboxEnv, store, session, controlPlane);
    status = response.status;
    body = await response.json().catch(() => null);
  } catch (error) {
    body = { error: String(error?.message ?? "the check-in failed").slice(0, 200) };
  }
  await gate.flush();
  const at = now();
  const said = typeof body?.answer === "string" ? body.answer : "";
  const failed = status >= 400 ? String(body?.error_description ?? body?.reason ?? body?.error ?? `answered ${status}`).slice(0, 200) : null;
  await callSandbox(stub, "row.add", {
    row: { id: replyId, reply: row.id, who: "Tex", text: said || quietLine(body, status), at, prod: false, from: "checkin", ms: at - started, steps: fitSteps(gate.book.view()), ...(said ? {} : { quiet: true }), ...(failed ? { error: failed } : {}) },
  }).catch(() => {});
  await gate.flush();
  await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
  return { status, outcome: body?.outcome ?? null, answer: said, ...(failed ? { error: failed } : {}) };
}
