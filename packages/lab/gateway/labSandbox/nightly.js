/**
 * RUN THE NIGHTLY NOW, FROM THE LAB (Dev2, 2026-11-20: the nightly cleanup gets its own Lab page, "and I do want the
 * ability to update it and then run it ... okay, let's run it now").
 *
 * `nightly` on a test chat of the caller's own 1:1 (`route.js`): the nightly graph (`agent/nightlyNow.js`) runs on the
 * test chat's draft over a copy-on-write sandbox of their workspace, so About me changes only in the test copy. The
 * run is a row in the test chat like a text's: every step shows on its card as it runs, and Tex's row under it says
 * what About me became. `real: true` (no test chat) runs it on the caller's own workspace instead, on main or a saved
 * draft, as tonight's run would: About me keeps its history, so a run can be put back from there.
 */

import { runNightlyNow, NIGHTLY_RUNS } from "../fromGateway/agent_nightlyNow.js";
import { TEX_CONFIG, withDraft } from "../fromGateway/agent_texConfig.js";
import { createControlPlane } from "../fromGateway/controlPlane.js";
import { attachContextOpener, onceEach } from "../fromGateway/http_contextOpener.js";
import { attachPinnedDoors } from "../fromGateway/http_pinnedDoors.js";
import { decorateRequestStore } from "../fromGateway/http_requestStore.js";
import { attachLinkCalls } from "../fromGateway/http_routing.js";
import { PINNED_CONTEXT_NAME } from "../fromGateway/orient_globalNote.js";
import { sessionFromPayload, storeForSession } from "../fromGateway/session.js";
import { sessionLedger } from "../fromGateway/agent_ledger.js";
import { sandboxEnvOf } from "../fromGateway/labSandbox_policy.js";
import { callSandbox } from "./object.js";
import { sandboxNamespace } from "./wire.js";
import { sandboxGate } from "./harness.js";
import { fitSteps } from "./steps.js";

const MAX_LINES_SHOWN = 12;

/** The store and session a nightly run reads and writes through, as a texted turn's are opened (`chatRun.js`). */
async function openStore({ env, controlPlane, payload, token, origin, gate = null }) {
  const session = sessionFromPayload(payload, null, token);
  if (gate !== null) Object.defineProperty(session, "labSandbox", { value: gate, enumerable: false });
  const store = await storeForSession(session, env, controlPlane);
  const request = new Request(`${origin}/agent`, { method: "POST" });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  decorateRequestStore(store, { session, env, controlPlane, ctx, request, origin });
  const openOnce = onceEach((target) => storeForSession(target, env, controlPlane));
  attachContextOpener(store, session, { env, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
  attachPinnedDoors(store, session, (sibling) => storeForSession(sibling, env, controlPlane), (o, sibling) => attachLinkCalls(o, sibling, controlPlane, env));
  return { store, session };
}

/** What Tex's row says after a run: About me's size before and after, and the lines that left and came. */
export function nightlySummary(result) {
  const about = result?.about ?? {};
  const removed = Array.isArray(about.removed) ? about.removed : [];
  const added = Array.isArray(about.added) ? about.added : [];
  const lines = [`About me: ${Number(about.before ?? 0).toLocaleString("en-US")} → ${Number(about.after ?? 0).toLocaleString("en-US")} characters.`];
  if (removed.length === 0 && added.length === 0) lines.push("Nothing in it changed.");
  for (const line of removed.slice(0, MAX_LINES_SHOWN)) lines.push(`− ${line}`);
  if (removed.length > MAX_LINES_SHOWN) lines.push(`− and ${removed.length - MAX_LINES_SHOWN} more`);
  for (const line of added.slice(0, MAX_LINES_SHOWN)) lines.push(`+ ${line}`);
  if (added.length > MAX_LINES_SHOWN) lines.push(`+ and ${added.length - MAX_LINES_SHOWN} more`);
  const ran = Array.isArray(result?.ran) ? result.ran : [];
  if (ran.length > 0) lines.push(`Steps: ${ran.join(" → ")}.`);
  return lines.join("\n");
}

/** Which nightly run was asked for: "dream" (with what follows it) or "housekeeping". */
export function runOf(input) {
  const run = input?.run ?? "dream";
  return NIGHTLY_RUNS.includes(run) ? run : null;
}

/**
 * The nightly in a test chat: a row for the run, its steps on the row's card as they run, Tex's row with the result.
 * `row` is the run's row (already added and claimed by the route), `config` the draft's (null: main's).
 */
export async function runNightlyInTestChat({ env, stub, about, row, payload, token, config, origin, run, now = Date.now }) {
  const started = now();
  const gate = sandboxGate(stub, about, row.id, { config, arrivedAt: row.at ?? started, now });
  gate.groups = null;
  gate.noNotes = false;
  const sandboxEnv = sandboxEnvOf(env, { gate, workspaces: sandboxNamespace(env.WORKSPACE_STORE, gate), tex: sandboxNamespace(env.TEX_STORE, gate) });
  const controlPlane = createControlPlane(sandboxEnv);
  const replyId = `${row.id}r`;
  try {
    const { store, session } = await openStore({ env: sandboxEnv, controlPlane, payload, token, origin, gate });
    const result = await runNightlyNow({
      env: sandboxEnv,
      store,
      session,
      controlPlane,
      config: config ? withDraft(TEX_CONFIG, config) : TEX_CONFIG,
      run,
      timeZone: about.timeZone ?? payload?.timeZone,
      writer: sessionLedger(sandboxEnv, session),
    });
    await gate.flush();
    const at = now();
    await callSandbox(stub, "row.add", { row: { id: replyId, reply: row.id, who: "Tex", text: nightlySummary(result), at, prod: false, from: "nightly", ms: at - started, steps: fitSteps(gate.book.view()) } });
    return result;
  } catch (error) {
    await gate.flush();
    const at = now();
    await callSandbox(stub, "row.add", { row: { id: replyId, reply: row.id, who: "Tex", text: "", at, prod: false, from: "nightly", quiet: true, ms: at - started, steps: fitSteps(gate.book.view()), error: String(error?.message ?? "the nightly run failed").slice(0, 200) } }).catch(() => {});
    return { error: String(error?.message ?? "the nightly run failed").slice(0, 200) };
  } finally {
    await gate.flush();
    await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
  }
}

/** The nightly on the caller's own workspace: real writes, kept in their chat's history like tonight's run. */
export async function runNightlyForReal({ env, payload, token, config, origin, run }) {
  const controlPlane = createControlPlane(env);
  const { store, session } = await openStore({ env, controlPlane, payload, token, origin });
  return await runNightlyNow({
    env,
    store,
    session,
    controlPlane,
    config: config ? withDraft(TEX_CONFIG, config) : TEX_CONFIG,
    run,
    timeZone: payload?.timeZone,
    writer: sessionLedger(env, session),
  });
}
