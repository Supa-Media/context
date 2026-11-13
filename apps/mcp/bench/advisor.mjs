/**
 * `pnpm ai advisor-chat | advisor-job-check | advisor-planner | advisor-job-mail [--only a,b] [--held-out <dir>] [--json <file>] [--fake]`
 *
 * Scores the advisor one role at a time (Dev2, 2026-11-13: split the advisor "up to be different agents so that they
 * can be evaluated separately"; docs/decisions/testing/advisor-roles.md). One model plays four roles, each with its
 * own instructions (`src/agent/advisorRoles/`), and each role here is put its cases exactly as production puts them:
 * the same brief builder, the same instructions behind the drawing, the same reading of its answer.
 *
 * - `advisor-chat`: `ask_advisor` (`advisor.js` `advisorTools`). A case says whether it should decline (`want:
 *   "decline"`) or advise (`want: "advise"`), what the advice must say (`says`, every pattern) and must not
 *   (`never`, no pattern), and in words what that is (`expect`, the gate's feedback).
 * - `advisor-job-check`: the job check (`jobCheck.js` `checkJob`). A case names the verdict it wants (`want`, one or a list).
 * - `advisor-planner`: `plan_big_ask` (`planBigAsk.js` `planBrief`, `parsePlan`). A case wants `now`, `one_job` or `split`.
 * - `advisor-job-mail`: the advisor on a job's mail (`jobNote.js` `jobMailBrief`). A case says what the answer must
 *   say and must not, as the chat role's do.
 *
 * The model and effort are production's (`@context-lc ai/production/texting-assistant.md`: `models.advisor`
 * Opus 5.5 at `advisor_effort: high`), through the AI gateway (`AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`,
 * `AI_GATEWAY_TOKEN`). `--fake` checks the plumbing only: its stand-in answers by the label. Nothing is written anywhere.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { aiGatewayConfig } from "../src/agent/aiGateway.js";
import { advisorTools } from "../src/agent/advisor.js";
import { adviseOnce, advisorRequest } from "../src/agent/advisorRoles/core.js";
import { ADVISOR_MAIL_PROMPT } from "../src/agent/advisorRoles/jobMail.js";
import { PLANNER_PROMPT } from "../src/agent/advisorRoles/planner.js";
import { checkJob } from "../src/agent/jobCheck.js";
import { jobMailBrief } from "../src/agent/jobNote.js";
import { parsePlan, planBrief } from "../src/agent/planBigAsk.js";
import { readHeldOut } from "./replayGate.mjs";
import { priceUsd } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES = join(HERE, "advisor");

/** Production's advisor (`models.advisor`, `advisor_effort`), 2026-11-13. */
export const ADVISOR_MODEL = "anthropic/claude-opus-5-5";
export const ADVISOR_EFFORT = "high";

/** A case's earlier texts and its turn so far as the turn's messages: `did` rows are [tool, args, result, "failed"?]. */
export function caseMessages(item) {
  const messages = (item.earlier ?? []).map(([who, text]) => ({ role: who === "tex" ? "assistant" : "user", text }));
  if (typeof item.q === "string") messages.push({ role: "user", text: item.q });
  for (const [name, args, result, failed] of item.did ?? []) {
    messages.push({ role: "assistant", text: "", toolCalls: [{ name, args: args ?? {} }] });
    messages.push({ role: "tool", name, text: String(result ?? ""), isError: failed === "failed" });
  }
  if (typeof item.draft === "string") messages.push({ role: "assistant", text: item.draft });
  return messages;
}

/** Whether free-form advice says every `says` pattern and none of `never`. */
export function saysRight(words, item) {
  const all = (item.says ?? []).every((pattern) => new RegExp(pattern, "i").test(words));
  const none = (item.never ?? []).every((pattern) => !new RegExp(pattern, "i").test(words));
  return all && none;
}

const declined = (words) => /^\s*Decline:/i.test(words);

/**
 * Each role: how a case is asked (`ask(item, request)` → `{ got, words, usage }`), whether what came back is right,
 * and what it was expected to do, for the gate's feedback (`replayGate.mjs` `feedback`).
 */
export const ROLES = {
  "advisor-chat": {
    file: "chat.json",
    async ask(item, request) {
      let usage = null;
      const metered = async (params) => {
        const answer = await request(params);
        usage = answer?.usage ?? null;
        return answer;
      };
      const [advisor] = advisorTools({ model: ADVISOR_MODEL, effort: ADVISOR_EFFORT, history: [], question: item.q ?? "", request: metered });
      const live = { about: item.about ?? "", now: item.now ?? "", tools: (item.tools ?? []).map((name) => ({ name })), messages: caseMessages(item) };
      const result = await advisor.call({}, live);
      const words = result.content.map((part) => part.text).join("\n");
      return { got: result.isError ? "failed" : declined(words) ? "decline" : "advise", words, usage };
    },
    right: (item, out) => out.got === item.want && (item.want === "decline" || saysRight(out.words, item)),
    expected: (item) => item.expect ?? (item.want === "decline" ? "decline the ask" : "advise"),
  },
  "advisor-job-check": {
    file: "job-check.json",
    async ask(item, request) {
      let usage = null;
      const metered = async (params) => {
        const answer = await request(params);
        usage = answer?.usage ?? null;
        return answer;
      };
      const job = { attempt: 1, asked: [], followUps: [], ...item.job };
      const check = await checkJob({ job, live: { messages: caseMessages(item) }, answer: item.answer ?? "", exhausted: item.exhausted === true, model: ADVISOR_MODEL, effort: ADVISOR_EFFORT, request: metered });
      return { got: check?.verdict ?? "no verdict", words: check?.advice ?? "", usage };
    },
    right: (item, out) => [item.want].flat().includes(out.got),
    expected: (item) => `say ${[item.want].flat().join(" or ")}`,
  },
  "advisor-planner": {
    file: "planner.json",
    async ask(item, request) {
      const computers = item.computers ?? [];
      const cloud = item.slots ?? 3;
      const freeOn = (computer) => computer.free ?? 0;
      const slots = cloud + computers.reduce((sum, computer) => sum + freeOn(computer), 0);
      const history = (item.earlier ?? []).map(([who, text]) => ({ role: who === "tex" ? "assistant" : "user", text }));
      const brief = planBrief({ history, question: item.q, ask: item.ask ?? item.q, slots, cloud, computers, freeOn });
      const answer = await adviseOnce({ request, model: ADVISOR_MODEL, effort: ADVISOR_EFFORT, prompt: PLANNER_PROMPT, role: "planner", brief });
      const plan = parsePlan(answer?.text, { slots, computers });
      return { got: plan === null ? "no plan" : plan.split ? "split" : plan.how, words: plan === null ? "" : plan.split ? plan.parts.map((part) => part.name).join(", ") : plan.why, parts: plan?.parts?.length ?? 0, usage: answer?.usage ?? null };
    },
    right: (item, out) => out.got === item.want && (item.want !== "split" || out.parts >= (item.minParts ?? 2)),
    expected: (item) => (item.want === "split" ? `split it into at least ${item.minParts ?? 2} parts` : item.want === "now" ? "say do it now" : "say one job"),
  },
  "advisor-job-mail": {
    file: "job-mail.json",
    async ask(item, request) {
      const brief = jobMailBrief({ title: item.job.title, brief: item.job.brief, doneWhen: item.job.doneWhen, from: item.from, noteText: item.note ?? "", question: item.question });
      const answer = await adviseOnce({ request, model: ADVISOR_MODEL, effort: ADVISOR_EFFORT, prompt: ADVISOR_MAIL_PROMPT, role: "jobAdvisor", brief });
      const words = typeof answer?.text === "string" ? answer.text.trim() : "";
      return { got: words ? "answer" : "no answer", words, usage: answer?.usage ?? null };
    },
    right: (item, out) => out.got === "answer" && saysRight(out.words, item),
    expected: (item) => item.expect ?? "answer the job",
  },
};

export async function loadRoleCases(role, dir = CASES) {
  const set = JSON.parse(await readFile(join(dir, ROLES[role].file), "utf8"));
  return set.cases.map((item) => ({ ...item, id: `${role}/${item.id}` }));
}

/** A stand-in for the model: answers each role's case by its label, so `--fake` proves the plumbing and nothing more. */
export function fakeRequest(role, item) {
  return async () => {
    const say = (text) => ({ text, usage: { input: 0, output: 0 } });
    if (role === "advisor-chat") return say(item.want === "decline" ? "Decline: answer it yourself." : (item.fakeSays ?? "Do it this way."));
    if (role === "advisor-job-check") return say(`VERDICT: ${[item.want].flat()[0]}\nADVICE: as labelled.`);
    if (role === "advisor-planner") {
      if (item.want !== "split") return say(JSON.stringify({ split: false, how: item.want, why: "as labelled" }));
      const parts = Array.from({ length: item.minParts ?? 2 }, (_, at) => ({ name: `part-${at + 1}`, title: `Part ${at + 1}`, brief: "As labelled.", done_when: "done" }));
      return say(JSON.stringify({ split: true, title: "Labelled", goal: "As labelled.", parts }));
    }
    return say(item.fakeSays ?? "Carry on.");
  };
}

/** Ask every case, `concurrency` at a time; each row says whether it came out right. */
export async function scoreRole(role, cases, requestFor, concurrency = 4) {
  const spec = ROLES[role];
  const out = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const at = next++;
        const item = cases[at];
        const started = Date.now();
        const answered = await spec.ask(item, requestFor(item)).catch((error) => ({ got: "error", words: String(error?.message ?? error), usage: null }));
        out[at] = { ...item, ...answered, right: spec.right(item, answered), expected: spec.expected(item), usd: priceUsd(ADVISOR_MODEL, answered.usage) ?? 0, ms: Date.now() - started };
      }
    }),
  );
  return out;
}

export function roleReport(role, scored) {
  const practice = scored.filter((item) => !item.heldOut);
  const held = scored.filter((item) => item.heldOut);
  const usd = scored.reduce((sum, item) => sum + item.usd, 0);
  const lines = [`## Advisor, ${role.replace(/^advisor-/, "")}: ${practice.filter((item) => item.right).length}/${practice.length} right`, "", `Spent about $${usd.toFixed(2)}.`, ""];
  for (const item of practice.filter((row) => !row.right)) lines.push(`- ${item.id}: expected to ${item.expected}; got ${item.got}: ${String(item.words).replace(/\s+/g, " ").slice(0, 240)}`);
  // A held-out case's words never reach the report: it is named by its cause alone.
  const wrong = held.filter((item) => !item.right);
  if (held.length) lines.push("", `Held-out: ${held.length - wrong.length}/${held.length} right${wrong.length ? `; wrong about ${[...new Set(wrong.map((item) => item.cause))].join(", ")}` : ""}.`);
  return `${lines.join("\n")}\n`;
}

/** The rows the gate reads (`replayGate.mjs` `rowsFor`): each case already says whether it was right. */
export const gateRows = (scored) => scored.map((item) => ({ id: item.id, right: item.right === true, must: item.must === true, heldOut: item.heldOut === true, cause: item.cause ?? null, target: item.target ?? null, expected: item.expected, usd: item.usd ?? 0 }));

export function advisorCommand(role) {
  return async (options, { write = (text) => process.stdout.write(text) } = {}) => {
    const only = options.only ? new Set(String(options.only).split(",")) : null;
    const cases = [...(await loadRoleCases(role)), ...(await readHeldOut(options["held-out"], role))].filter((item) => !only || only.has(item.id));
    const config = aiGatewayConfig(process.env);
    if (!options.fake && config === null) throw new Error("set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN");
    const real = options.fake ? null : advisorRequest({ ai: null, gateway: config, metadata: { feature: "bench", client: role } });
    // One at a time by default: the role's instructions (the drawing included) are cached after the first ask, so the
    // rest read them at a tenth of the price.
    const scored = await scoreRole(role, cases, (item) => (options.fake ? fakeRequest(role, item) : real), Number(options.concurrency ?? 1));
    write(roleReport(role, scored));
    if (options.json) await writeFile(options.json, JSON.stringify(gateRows(scored)));
    return scored;
  };
}
