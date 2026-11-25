/**
 * ONE SANDBOX BENCH UNIT'S TURN (plan `products/tex/research/sandbox-bench-scoring-2026-11-19.md`): a Front door unit
 * test of a Training or Dev conversation, run as the Lab's own test chat runs a text, and read back for the judge.
 *
 * The test chat opens on the conversation cut just before the unit's message, exactly as the Lab's `open { source:
 * "set", base }` opens one (`route.js`), on the run's draft or main. The message goes in as its speaker through the
 * same steps `route.js` `addRow` takes, with two differences that make it a bench text: it draws from the sandbox
 * bench's own budget (taken by the caller, `benchRoute.js`), never the person's test texts a day, and a turn's asks of
 * other chats are not carried (a bench unit is one turn). Then the test chat is reset, so a run leaves none behind.
 *
 * What comes back is what the driver's judge needs, never more: Tex's texts, the tools its steps called, what it would
 * have changed, each model's usage, and each fallback step the turn's ledger kept (`ledger.js` STEP_NAMES "fallback"),
 * which the driver counts with the GitHub run's own code (`apps/mcp/bench/rowAccounting.mjs` `fallbackToolsOf`).
 */

import { callSandbox, sandboxStub } from "./object.js";
import { RUNNING_STALE_MS } from "./harness.js";
import { inboundEvent } from "./inbound.js";
import { lineOf, rowLine } from "./line.js";
import { handleOf } from "./conversations.js";
import { notWords } from "../../src/labRunSets.mjs";

/** The most of a turn's parts kept: Tex's texts, tools and changes. */
const MAX_SAID = 20;
const MAX_TOOLS = 100;
const MAX_CHANGES = 20;

// Which units run here at all is the shared rule (`labRunSets.mjs` `notWords`), also the parity estimate's.
export { notWords };

/** A turn's reading for the judge, from the test chat's state after it and its ledger entries. */
export function turnOf(state, row, entries, ms) {
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  const at = rows.findIndex((r) => r.id === row.id);
  const replies = rows.slice(at + 1).filter((r) => r && r.who === "Tex");
  const failed = replies.find((r) => typeof r.error === "string" && r.error !== "");
  if (failed) return { ran: false, error: `the turn failed: ${failed.error}`.slice(0, 300), ms };
  const said = replies
    .filter((r) => r.quiet !== true)
    .flatMap((r) => (Array.isArray(r.parts) && r.parts.length > 0 ? r.parts : [r.text]))
    .filter((text) => typeof text === "string" && text.trim() !== "")
    .slice(0, MAX_SAID);
  const steps = replies.flatMap((r) => (Array.isArray(r.steps) ? r.steps : []));
  const tools = steps
    .flatMap((s) => (Array.isArray(s?.calls) ? s.calls : []))
    .filter((c) => typeof c?.tool === "string")
    .map((c) => ({ tool: c.tool, ok: !/\(failed\)$/.test(String(c.d ?? "")) }))
    .slice(0, MAX_TOOLS);
  const usage = steps
    .filter((s) => typeof s?.model === "string" && (Number.isFinite(s.tokIn) || Number.isFinite(s.tokOut)))
    .map((s) => ({ model: s.model, input: Number(s.tokIn) || 0, output: Number(s.tokOut) || 0, ...(Number.isFinite(s.cost) ? { cost: s.cost } : {}) }));
  const changes = (Array.isArray(state?.writes) ? state.writes : [])
    .filter((w) => w && w.by === row.id)
    .slice(0, MAX_CHANGES)
    .map((w) => ({ kind: String(w.kind ?? "change"), title: String(w.title ?? w.summary ?? "").slice(0, 200) }));
  const fallbacks = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.kind === "step" && e.step === "fallback")
    .map((e) => ({ kind: "step", step: "fallback", model: e.model ?? e.output?.model ?? null, input: { status: e.input?.status ?? null } }));
  return { ran: true, said, tools, changes, usage, fallbacks, ms, at: row.at };
}

/**
 * Runs one unit: `{ ran: true, said, tools, changes, usage, fallbacks, ms, at, kind }` or `{ ran: false, error, ms }`.
 * `helpers` are the route's own (`open`, `newIds`, `indexStub`); `runTurn` is the Lab's test-chat turn.
 */
export async function runBenchUnit({ env, controlPlane, token, who, origin, job, unit, conv, runTurn, helpers, now = Date.now }) {
  const started = now();
  const out = (fields) => ({ ...fields, ms: now() - started, ...(conv?.kind ? { kind: conv.kind } : {}) });
  const m = conv?.msgs?.[unit.at];
  const why = notWords(m);
  if (why !== null) return out({ ran: false, error: `the sandbox bench runs texted words only: ${why}` });
  if (conv.kind === "group" && typeof job.groupChat !== "string") return out({ ran: false, error: "a group conversation runs in one of your group chats: start the run with --group-chat" });

  const opened = await helpers.open(env, controlPlane, token, who, { source: "set", convId: unit.chat, base: m.id, versionId: job.versionId, chatId: conv.kind === "group" ? job.groupChat : undefined, by: "bench" }, origin);
  const said = await opened.json().catch(() => null);
  if (!opened.ok || typeof said?.sandboxId !== "string") return out({ ran: false, error: `could not open the test chat: ${String(said?.error ?? opened.status)}` });
  const sandboxId = said.sandboxId;
  const stub = sandboxStub(env, who.userId, sandboxId);
  try {
    const state = await callSandbox(stub, "state", {});
    const about = state.meta.chat;
    const answer = await controlPlane.labSandbox(token, "session", { chat: about.chat });
    if (answer?.status !== "ok") return out({ ran: false, error: `no session for the test chat: ${String(answer?.error ?? "the control plane did not answer")}` });
    const { at, eid, id } = helpers.newIds();
    // A quoted reply quotes its row of the test chat's start, as the Lab's `send { replyTo }` does.
    const quoted = m.kind === "reply" && (state.rows ?? []).some((r) => r.id === m.to) ? { replyTo: m.to } : {};
    const row = { id, eid, who: conv.kind === "group" ? handleOf(m.who) : "You", text: m.text, at, prod: false, line: rowLine(lineOf(about)), ...quoted };
    const claimed = await callSandbox(stub, "claim", { msgId: row.id, staleMs: RUNNING_STALE_MS });
    if (!claimed.ok) return out({ ran: false, error: "the test chat was busy" });
    await callSandbox(stub, "row.add", { row });
    const logged = typeof runTurn.logsText === "function" && runTurn.logsText(row);
    if (!logged) await callSandbox(stub, "ledger.append", { entries: [await inboundEvent({ about, row, rows: [...(state.rows ?? []), row] })], by: row.id });
    // The turn, held by this request: no asks of other chats carried after it.
    await runTurn({ env, stub, about, row, payload: answer.session, token, config: about.config ?? null, origin, chat: answer.chat ?? null });
    const after = await callSandbox(stub, "state", {});
    const entries = await callSandbox(stub, "ledger.of", { by: row.id }).then((read) => read.entries ?? []).catch(() => []);
    return { ...turnOf(after, row, entries, now() - started), kind: conv.kind };
  } catch (error) {
    return out({ ran: false, error: String(error?.message ?? error).slice(0, 300) });
  } finally {
    // A bench leaves no test chat behind: the chat deleted, and taken off the person's list.
    await callSandbox(stub, "reset", {}).catch(() => {});
    await callSandbox(helpers.indexStub(env, who.userId), "meta", { key: `sb:${sandboxId}`, value: null }).catch(() => {});
  }
}
