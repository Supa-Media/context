/**
 * `/agent/try` — the AI tab's Try it (decided by the owner, 2026-10-16: "some
 * sort of way that I'm able to test it and edit what the golden tests are").
 * A person who can edit `@context-lc` chats with any setup in its `ai/`
 * folder, as themselves, and every reply is checked against the golden case
 * open beside it.
 *
 * ## Why it is safe to let a setup that is not live answer
 *
 * - **Who.** Only the app's own console grant reaches this, and the control
 *   plane starts the turn only when that grant's person is an owner or editor
 *   of `@context-lc` (`apps/convex/functions/builtinModel.ts`), the people who
 *   can already write the setup being tried. The role is checked there, from
 *   the grant, never from anything the request says.
 * - **What it reads.** A setup is read from `@context-lc` under the caller's
 *   own clearance (`readSetupAt`), and only a path under `ai/production/` or
 *   `ai/setups/<job>/`. The turn reads the caller's own notes, with their own
 *   grant: nothing they could not read in the app.
 * - **What it changes: nothing.** The turn runs on a session whose scopes are
 *   read-only, is offered only read-only tools, and a call to any other tool
 *   name is refused here before it reaches the dispatcher (a cross-context
 *   call opens its context from the connection's own grant, so the clamp
 *   alone would not hold there). No web, no browser, no texting writes, no
 *   saved conversation, no transcript: a try leaves no trace in their notes.
 */

import { json } from "../http/responses.js";
import { contextsFor } from "../context/identity.js";
import { grantedToolsFor } from "./sixTools.js";
import { callToolForSession } from "../tools/session.js";
import { newLedger } from "../privacy/egress.js";
import { SCOPE_PRIVATE, SCOPE_READ } from "../session.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { BUILTIN_PROVIDER, canRunBuiltin, hasBuiltinModel } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { decisionEngine } from "./decide.js";
import { readProductionSkill, readSetupAt } from "./production.js";
import { skillSession, withSkills } from "./skills.js";
import { trimHistory } from "./conversation.js";
import { searchSettingsOf } from "../search/settings.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { agentTools, MAX_QUESTION_LENGTH, runTurn } from "./turn.js";

/** The app's own client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

/** How much of the chat so far goes back with each try. */
const MAX_TRY_HISTORY_TURNS = 16;
const MAX_TRY_HISTORY_CHARS = 16_000;
/** A case has a handful of rules; this bounds the judge's prompt. */
const MAX_RULES = 24;
const MAX_RULE_CHARS = 400;
/** A judge's verdicts are short; a try that runs long stops here. */
const TRY_MAX_ROUNDS = 12;

/** The rule kinds the judge checks; the record checks (`must call`, …) need the bench's record. */
const JUDGED = new Set(["must", "must not", "may", "judge"]);

const JUDGE_PROMPT = [
  "You check one reply from an assistant against a list of rules, the way a careful reviewer would.",
  "For each rule, decide whether the reply follows it. A `must` line passes when the reply does it.",
  "A `must not` line passes when the reply does not do it. A `may` or `judge` line passes when the reply meets it.",
  "Answer with JSON only, no prose: {\"checks\":[{\"rule\":<number>,\"pass\":<true|false>,\"why\":\"<under 15 words>\"}]}",
].join("\n");

/** The session the try runs on: the same person and grant, able to read and nothing else. */
export function readOnlySession(session) {
  const keep = (scopes) => (Array.isArray(scopes) ? scopes.filter((scope) => scope === SCOPE_READ || scope === SCOPE_PRIVATE) : scopes);
  const clamped = { ...session, scopes: keep(session.scopes), grantScopes: keep(session.grantScopes) };
  Object.defineProperty(clamped, "accessToken", { value: session.accessToken, enumerable: false, writable: false });
  clamped.egress = { complete: true, ledger: newLedger(), texting: false };
  return clamped;
}

/**
 * The try's dispatcher: only a tool it was offered reaches `call`. `runTurn`
 * already answers an unoffered name itself; this holds even if it did not,
 * because a cross-context call opens its context from the connection's own
 * grant, past the read-only clamp.
 */
export function tryDispatcher(tools, call) {
  const allowed = new Set(tools.map((tool) => tool.name));
  return (name, args) =>
    allowed.has(name) ? call(name, args) : Promise.resolve({ isError: true, content: [{ type: "text", text: "Not available in Try it." }] });
}

/** Whether this connection's person may edit `@context-lc`, as far as the gateway knows; the control plane decides again. */
function editsAiNotes(session) {
  const pinned = contextsFor(session).find((entry) => entry.name === PINNED_CONTEXT_NAME);
  return pinned !== undefined && (pinned.role === "owner" || pinned.role === "editor");
}

/** The request's chat so far, as the turn's history: words only, alternating, the newest kept. */
export function tryHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const turns = [];
  for (const entry of raw.slice(-MAX_TRY_HISTORY_TURNS)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.question !== "string" || typeof entry.answer !== "string") continue;
    turns.push({ role: "user", text: entry.question.slice(0, MAX_QUESTION_LENGTH) }, { role: "assistant", text: entry.answer.slice(0, MAX_QUESTION_LENGTH) });
  }
  return trimHistory(turns, { turns: MAX_TRY_HISTORY_TURNS * 2, chars: MAX_TRY_HISTORY_CHARS });
}

/** The case's rules the judge can check, bounded; anything else is left for the bench. */
export function tryRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((rule) => rule && typeof rule.key === "string" && typeof rule.value === "string" && JUDGED.has(rule.key.trim()))
    .slice(0, MAX_RULES)
    .map((rule) => ({ key: rule.key.trim(), value: rule.value.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_RULE_CHARS) }))
    .filter((rule) => rule.value !== "");
}

/** The judge's answer read leniently: one verdict per rule, `null` where it said nothing usable. */
export function readVerdicts(answer, count) {
  const verdicts = Array.from({ length: count }, () => null);
  const start = typeof answer === "string" ? answer.indexOf("{") : -1;
  const end = typeof answer === "string" ? answer.lastIndexOf("}") : -1;
  if (start === -1 || end <= start) return verdicts;
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1));
    for (const check of Array.isArray(parsed?.checks) ? parsed.checks : []) {
      const index = Number(check?.rule) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= count || typeof check.pass !== "boolean") continue;
      verdicts[index] = { pass: check.pass, why: typeof check.why === "string" ? check.why.slice(0, 200) : "" };
    }
  } catch {
    // An unreadable judge leaves every rule unchecked rather than failing the try.
  }
  return verdicts;
}

export async function handleTryIt(request, env, store, session, controlPlane) {
  if (session.actorClientId !== CONSOLE_CLIENT_ID || !editsAiNotes(session)) {
    return json({ error: "forbidden", error_description: "Try it is for the people who can edit @context-lc." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
    return json({ error: "invalid_request", error_description: "Type what the person texts." }, 400);
  }
  // Who this person is where, as `/agent` sets it: the setup is read from `@context-lc` through it.
  store.contexts = contextsFor(session);
  const setup = await readSetupAt(store, session, body.setup);
  if (setup === null) {
    return json({ error: "invalid_request", error_description: "That setup could not be read, or is not a setup." }, 400);
  }
  if (!hasBuiltinModel(env)) return json({ error: "no_provider", error_description: "The assistant isn't available here yet." }, 409);
  const verdict = await controlPlane.startBuiltinTurn(session.accessToken, session.workspaceId, { tryIt: true }).catch(() => undefined);
  if (verdict === undefined) return json({ error: "model_unavailable" }, 503);
  if (verdict?.allowed !== true) {
    const reason = verdict?.reason === "daily_cap" ? "Today's questions are used up." : "Try it isn't available to this account.";
    return json({ error: verdict?.reason ?? "forbidden", error_description: reason }, verdict?.reason === "daily_cap" ? 429 : 403);
  }

  const reader = readOnlySession(session);
  // The setup's own search settings, as `/agent` applies a live one's.
  if (setup.search) store.searchSettings = searchSettingsOf(store, setup.search);
  const offered = await grantedToolsFor(reader, store);
  const skills = skillSession(setup.skills ?? [], (path) => readProductionSkill(store, session, path));
  const tools = [...agentTools(offered).filter((tool) => tool.name !== "propose_note"), ...(skills?.tools ?? [])];
  const dispatch = tryDispatcher(tools, (name, args) => callToolForSession({ name, arguments: args }, store, reader));
  const model = canRunBuiltin(setup.model, env) ? setup.model : undefined;
  const router =
    model !== undefined && setup.router !== null && canRunBuiltin(setup.router.think, env)
      ? { decide: decisionEngine(env.AI), think: setup.router.think, routeAt: setup.router.routeAt }
      : null;
  const fallback = model !== undefined && setup.fallback !== null && canRunBuiltin(setup.fallback, env) ? setup.fallback : null;
  const providerOptions = (client) => ({
    ai: env.AI,
    gateway: aiGatewayConfig(env),
    metadata: { feature: "assistant", workspace: String(session.workspaceId), client, setup: setup.version },
  });
  const meter = async (usage, failed, used, started) => {
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        model: typeof used === "string" ? used : model,
        decision: usage?.decision ?? 0,
        failed,
        ms: Date.now() - started,
        tryIt: true,
      });
    } catch {
      // Counts only, best effort, as `/agent` meters.
    }
  };

  const started = Date.now();
  let turn;
  try {
    turn = await runTurn({
      question,
      tools,
      callTool: withSkills(skills, dispatch),
      env,
      providerOptions: providerOptions("try"),
      history: tryHistory(body.history),
      texting: setup.job === "texting-assistant",
      notes: { prompt: setup.prompt },
      builtinModelOverride: model,
      router,
      efforts: setup.efforts ?? null,
      fallback,
      maxRounds: Math.min(setup.maxSteps ?? TRY_MAX_ROUNDS, TRY_MAX_ROUNDS),
      localNow: { now: Date.now(), timeZone: readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE },
      workspaces: contextsFor(session),
    });
  } catch {
    await meter(null, true, model, started);
    return json({ error: "model_unavailable" }, 503);
  }
  await meter(turn.usage, false, turn.model, started);

  const rules = tryRules(body.rules);
  let checks = [];
  if (rules.length > 0 && !turn.exhausted) {
    const judged = Date.now();
    const listed = rules.map((rule, index) => `${index + 1}. ${rule.key}: ${rule.value}`).join("\n");
    try {
      const judge = await runTurn({
        question: `The person texted:\n${question}\n\nThe reply:\n${turn.answer}\n\nThe rules:\n${listed}`,
        tools: [],
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "No tools." }] }),
        env,
        providerOptions: providerOptions("try-judge"),
        notes: { prompt: JUDGE_PROMPT },
        builtinModelOverride: model,
        maxRounds: 1,
      });
      await meter(judge.usage, false, judge.model, judged);
      const verdicts = readVerdicts(judge.answer, rules.length);
      checks = rules.map((rule, index) => ({ ...rule, pass: verdicts[index]?.pass ?? null, why: verdicts[index]?.why ?? "" }));
    } catch {
      await meter(null, true, model, judged);
      checks = rules.map((rule) => ({ ...rule, pass: null, why: "" }));
    }
  }

  return json({
    answer: turn.answer,
    provider: BUILTIN_PROVIDER,
    model: turn.model,
    steps: turn.steps,
    checks,
    ...(turn.exhausted ? { exhausted: true } : {}),
  });
}
