/**
 * tex_dev's sandbox op `note_run` (`packages/lab/gateway/texDev/tool.js`): one ask run as `POST /tex/note-run` runs it
 * (`noteRunRoute.js`), on a Lab draft's `noteRun` node (or main's, or the shelf's definition while neither has it), for
 * a note the caller can read, and answered whole: every line the route would stream, the calls, the model and the time.
 * Lab parity (Dev2, 2026-11-15): what the app can run, the Lab can run and read. Nothing is logged in the note's run
 * log and nothing is written: the run only reads, as the route's does.
 */
import { parseRunBody, readNoteAs, targetOf } from "./noteRunRoute.js";
import { ledgerFor } from "./ledger.js";
import { ownDispatch } from "./reflect.js";
import { grantedToolsFor } from "./sixTools.js";
import { DEFAULT_TIME_ZONE } from "./localNow.js";
import { texConfigOf, texStep } from "./texConfig.js";
import { createControlPlane } from "../../../../apps/mcp/src/controlPlane.js";
import SHELF from "../../src/texNodeShelf.json" with { type: "json" };

/** The node a run uses: the draft's when it has one, else main's, else the shelf's definition (never run live from there). */
export function labNoteRunNode(env, draftNode = null) {
  if (draftNode && typeof draftNode === "object" && draftNode.id === "noteRun") return { node: draftNode, from: "draft" };
  try {
    const live = texStep("noteRun", texConfigOf(env));
    if (live) return { node: live, from: "main" };
  } catch {
    // Fall through to the shelf.
  }
  const shelved = SHELF?.nodes?.noteRun?.node;
  return shelved ? { node: shelved, from: "shelf" } : { node: null, from: null };
}

/** The op: `args` as the route's body (thread, anchor and history may be left out) plus `draft`'s node, `deps` for tests. */
export async function noteRunFromLab({ env, store, session, args, draftNode = null }, deps = {}) {
  const body = { thread: "lab", anchor: { text: "", before: "", after: "" }, history: [], pending: null, ...(args ?? {}) };
  delete body.op;
  delete body.draft;
  const parsed = parseRunBody(body);
  if (parsed.error) return { error: parsed.error };
  const target = targetOf(session, parsed.workspace);
  if (target === null) return { error: "This connection has no access to that workspace; call orient to see the ones it reaches." };
  const { node, from } = labNoteRunNode(env, draftNode);
  if (node === null) return { error: "There is no noteRun node on the draft, on main or on the shelf. Add it to the draft, then try again." };
  const dispatch = deps.dispatchFor ? deps.dispatchFor(store, session) : ownDispatch(store, session, env);
  const note = await readNoteAs(dispatch, parsed.path, target.context);
  if (note === null) return { error: "That note can't be read with your access. Name a note you can see, then try again." };
  const runNoteRun = deps.runNoteRun ?? (await import("./noteRun.js")).runNoteRun;
  const lines = [];
  const started = Date.now();
  const result = await runNoteRun({
    env,
    controlPlane: deps.controlPlane ?? createControlPlane(env),
    session,
    dispatch,
    offered: deps.offered ?? (await grantedToolsFor(session, store, { texts: true })),
    ledger: deps.ledger !== undefined ? deps.ledger : ledgerFor(env, { person: session.workspaceId }) ?? null,
    workspace: target.context ?? null,
    path: parsed.path,
    noteText: note.note,
    anchor: parsed.anchor,
    ask: parsed.ask,
    history: parsed.history,
    pending: parsed.pending,
    audience: note.audience,
    node,
    thread: parsed.thread,
    now: started,
    timeZone: DEFAULT_TIME_ZONE,
    onStep: (step) => lines.push({ type: "step", ...step }),
  }).catch((error) => ({ outcome: "failed", why: String(error?.message ?? error?.name ?? "error").slice(0, 200) }));
  if (result.outcome === "answered") {
    lines.push({ type: "answer", text: result.answer });
    if (typeof result.replace === "string") lines.push({ type: "edit", replace: result.replace });
    lines.push({ type: "done", runId: "lab", sources: result.sources ?? [] });
  } else {
    lines.push({ type: "error", message: result.outcome });
  }
  return {
    node: { from, id: node.id, model: node.model ?? null, effort: node.effort ?? null, rounds: node.rounds ?? null },
    audience: note.audience,
    outcome: result.outcome,
    lines,
    calls: result.calls ?? [],
    model: result.model ?? null,
    usage: result.usage ?? null,
    ms: Number.isFinite(result.ms) ? result.ms : Date.now() - started,
    ...(result.why ? { why: result.why } : {}),
  };
}
