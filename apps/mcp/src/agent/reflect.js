/**
 * THE REFLECT STEP: AFTER A HARD TEXTED JOB, TEX WRITES DOWN HOW (owner, 2026-10-19).
 *
 * "Tex should write down how it did a job that was hard, so the next time is
 * easy." After a texted turn has answered (`route.js`, deferred, so the
 * person's answer never waits), one small model turn may write or update one
 * learned skill (`learnedSkills.js`), or answer NONE. It runs only when all of:
 *
 *   - the turn was a text from the person (`context_texts`), and could write;
 *   - if it was tainted (something from outside the workspace was read: a web
 *     page, an email, another agent's mail, an attachment), the text was the
 *     person's own (`ownText`: not a routine, a delegated job or a group), and
 *     the step is shown only what nobody outside wrote (`reflectQuestion`);
 *   - it finished (not exhausted);
 *   - and it was hard: `MIN_STEPS` tool steps or more, a step that failed and
 *     a later one that worked, or a text that reads as a correction.
 *
 * The model is shown the person's text, Tex's answer, the step names with
 * ok/failed (never a tool's arguments or result) and the skill index, and may
 * call `read_note` and `write_note` on `tex/skills/<name>.md` in their own
 * workspace and nothing else (`reflectCallTool`), writing once at most. It
 * runs on the built-in model, metered like the dream, and any failure is a
 * code in the Worker's log that costs the person nothing.
 *
 * A TAINTED TURN REFLECTS BLIND (owner, 2026-10-21). Until then a tainted turn
 * never reflected, and since taint carries over from the shown history, almost
 * every real job (an email read, a page browsed, a calendar looked at) wrote
 * nothing: nobody had a skill. A tainted turn's reflect step now sees only
 * what no outsider wrote: the person's own text, the step names (held to a
 * tool-name shape, so a name can't carry a sentence) and their skill index.
 * Tex's answer, which may repeat a page's or an email's words, is left out, so
 * an outsider's instructions still can't reach a skill.
 */

import { runTurn } from "./turn.js";
import { builtinModel } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { ProviderError } from "./providers.js";
import { builtinMeter, dayOf } from "./jobLog.js";
import { callToolForSession } from "../tools/session.js";
import { newLedger } from "../privacy/egress.js";
import { memoryNudge } from "./memoryNudge.js";
import {
  LEARNED_SKILL_PATH,
  MAX_LEARNED_BODY_CHARS,
  MAX_LEARNED_SKILLS,
  MAX_LEARNED_WHEN_CHARS,
  listSkillNames,
  skillWriteRefusal,
  stampUsed,
} from "./learnedSkills.js";

/** The texting assistant's first-party client, as `route.js` names it. */
const TEXTS_CLIENT_ID = "context_texts";
/** Tool steps that make a turn hard enough to write down. */
export const MIN_STEPS = 6;
export const REFLECT_ROUNDS = 4;
const MAX_ANSWER_SHOWN = 2_000;
const MAX_STEPS_SHOWN = 40;
const NONE = "NONE";

const REFLECT_READS = new Set(["read_note"]);
const WRITE_ARGS = new Set(["path", "content", "expected_etag"]);

/**
 * Whether the person's text reads as a correction of Tex. Deliberately plain:
 * its opening words, nothing more.
 */
export function looksLikeCorrection(text) {
  const opening = String(text ?? "").trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return /^(?:no|nope|not that|wrong|actually|that's not|that is not|thats not)\b/.test(opening);
}

/** Whether `steps` hold a failed step followed, later, by one that worked. */
export function recoveredFromFailure(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const failed = list.findIndex((step) => step?.ok === false);
  return failed !== -1 && list.slice(failed + 1).some((step) => step?.ok === true);
}

/** A step name a tainted turn's reflect step may be shown: shaped like a tool's name, never a sentence. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Why this turn is worth a reflect step (`steps`, `recovered`, `correction`),
 * or null when it is not. A tainted turn qualifies only on the person's own
 * text (`ownText`); a turn whose taint is unknown never does.
 */
export function reflectReason({ texted, canWrite, tainted, ownText, exhausted, steps, question }) {
  if (texted !== true || canWrite !== true || typeof tainted !== "boolean" || exhausted === true) return null;
  if (tainted && ownText !== true) return null;
  if ((Array.isArray(steps) ? steps.length : 0) >= MIN_STEPS) return "steps";
  if (recoveredFromFailure(steps)) return "recovered";
  if (looksLikeCorrection(question)) return "correction";
  return null;
}

function refused(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The reflect step's dispatcher: `read_note` and `write_note`, only on
 * `tex/skills/<name>.md`, only in their own workspace, a write held to the
 * skill's format and the 40-skill cap and made once at most. Everything else
 * is refused here, before the session's dispatcher is reached.
 */
export function reflectCallTool(dispatch) {
  let wrote = false;
  const call = async (name, args) => {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (given.context !== undefined) return refused("Skills are written in their own workspace only.");
    if (!REFLECT_READS.has(name) && name !== "write_note") return refused(`Reflecting can't use ${String(name).slice(0, 40)}.`);
    if (typeof given.path !== "string" || !LEARNED_SKILL_PATH.test(given.path)) return refused("Only tex/skills/<name>.md can be read or written here.");
    if (REFLECT_READS.has(name)) return await dispatch("read_note", { path: given.path });
    if (wrote) return refused("One skill is written per job. Stop here.");
    const extra = Object.keys(given).filter((key) => given[key] !== undefined && !WRITE_ARGS.has(key));
    if (extra.length > 0) return refused(`A skill is written with path, content and expected_etag only: ${extra.join(", ")} can't be set.`);
    const refusal = skillWriteRefusal(given.path, given.content, await listSkillNames(dispatch));
    if (refusal !== null) return refused(`${refusal} Nothing was written.`);
    const written = await dispatch("write_note", {
      path: given.path,
      content: given.content,
      ...(typeof given.expected_etag === "string" ? { expected_etag: given.expected_etag } : {}),
    });
    if (written?.isError !== true) wrote = true;
    return written;
  };
  call.wrote = () => wrote;
  return call;
}

/** The tools the reflect step is offered: the session's own definitions of the two it may call. */
export function reflectTools(offered) {
  return (Array.isArray(offered) ? offered : []).filter((tool) => REFLECT_READS.has(tool.name) || tool.name === "write_note");
}

const WHY = {
  steps: `it took ${MIN_STEPS} or more steps`,
  recovered: "a step failed before another one worked",
  correction: "they corrected you",
};

/**
 * What the reflect step is asked. On a tainted turn (`tainted`), never Tex's
 * answer, and only the steps whose names are shaped like a tool's.
 */
export function reflectQuestion({ question, answer, steps, index, used, reason, today, tainted = false }) {
  const said = String(answer ?? "").trim();
  const listed = Array.isArray(steps) ? steps : [];
  const shownSteps = (tainted ? listed.filter((step) => TOOL_NAME.test(String(step?.tool ?? ""))) : listed).slice(0, MAX_STEPS_SHOWN);
  const answerPart = tainted
    ? "## Your answer\n\n(Not shown: this job read something from outside their workspace, so you see only their own text and your steps. Write the skill from those alone.)"
    : `## Your answer\n\n${said.length > MAX_ANSWER_SHOWN ? `${said.slice(0, MAX_ANSWER_SHOWN)}…` : said}`;
  return [
    "This is not a text from a person. Nobody is waiting, and nothing you say is texted to anyone.",
    `You just finished a job for them, and it was hard: ${WHY[reason] ?? "it was hard"}. ` +
      "Decide whether a skill, short steps for next time, would make the same kind of job easy. " +
      "Write one only for a job that will come again and where you now know a better way: what worked, what to skip, what to check first. " +
      `If nothing is worth writing down, answer exactly ${NONE} and call nothing.`,
    `How to write one: write the whole note to tex/skills/<name>.md in their own workspace (a lowercase name of letters, digits and dashes). ` +
      `Front matter between --- lines with exactly: name: <the same name>, when: <one line, at most ${MAX_LEARNED_WHEN_CHARS} characters, saying when it applies>, updated: ${today}. ` +
      `Then numbered steps, at most ${MAX_LEARNED_BODY_CHARS} characters, general enough for next time: no one-off details, no secrets, no codes, and no addresses or people to send to unless the job is always about them. ` +
      `If a skill below already covers this job${used.length > 0 ? " (or the one you used)" : ""}, read it with fetch first and write it back improved, passing its etag, rather than adding a near-duplicate. ` +
      `At most ${MAX_LEARNED_SKILLS} skills exist; write one note at most. Then answer DONE.`,
    `## Their text\n\n${String(question ?? "").trim()}`,
    answerPart,
    `## Your steps\n\n${shownSteps.map((step, i) => `${i + 1}. ${String(step?.tool ?? "?").slice(0, 64)}: ${step?.ok === false ? "failed" : "ok"}`).join("\n") || "(none)"}`,
    `## Skills you have\n\n${index.length > 0 ? index.map((entry) => `- ${entry.name}: ${entry.when}`).join("\n") : "(none yet)"}` +
      (used.length > 0 ? `\n\nYou used this turn: ${used.join(", ")}.` : ""),
  ].join("\n\n");
}

/**
 * The texting session's dispatcher, under a ledger of its own: nothing the
 * reflect step does can add to, or be held by, the turn's asks.
 */
function ownDispatch(store, session) {
  const own = { ...session, egress: { ...(session.egress ?? {}), ledger: newLedger() } };
  Object.defineProperty(own, "accessToken", { value: session.accessToken, enumerable: false });
  return (name, args) => callToolForSession({ name, arguments: args }, store, own);
}

function log(session, fields) {
  console.log(JSON.stringify({ event: "reflect", workspace: session.workspaceId, grant: session.grantId, ...fields }));
}

/**
 * After a turn has answered: stamp the learned skills it read, reflect when
 * the turn qualifies (`reflectReason`), and nudge the memory every 10 texts
 * (`memoryNudge.js`). Never throws, never texts.
 *
 * @param {object} options
 * @param {{index: Array, used: Set<string>} | null} options.learned the turn's `learnedSkillSession`
 */
export async function afterTextedTurn({ env, controlPlane, store, session, offered, question, turn, tainted, ownText = false, learned, canWrite, now = Date.now(), timeZone }) {
  try {
    const texted = session?.actorClientId === TEXTS_CLIENT_ID;
    const personal = (store?.contexts ?? []).find((entry) => entry.current)?.kind === "personal";
    if (!texted || !canWrite || !personal) return;
    const dispatch = ownDispatch(store, session);
    const today = dayOf(now, timeZone);
    const used = [...(learned?.used ?? [])];
    if (used.length > 0) await stampUsed(dispatch, used, today);
    await reflect({ env, controlPlane, session, offered, question, turn, tainted, ownText, learned, canWrite, texted, dispatch, used, today });
    // Every 10 texts, what was learned goes to about-me now, not at the dream (`memoryNudge.js`).
    await memoryNudge({ env, controlPlane, store, session, offered, dispatch, now, current: { question, answer: turn?.answer, tainted } });
  } catch (error) {
    log(session ?? {}, { outcome: "failed", code: error?.name === "TypeError" ? "type" : "error" });
  }
}

async function reflect({ env, controlPlane, session, offered, question, turn, tainted, ownText, learned, canWrite, texted, dispatch, used, today }) {
  try {
    const reason = reflectReason({ texted, canWrite, tainted, ownText, exhausted: turn?.exhausted === true, steps: turn?.steps, question });
    if (reason === null) return;
    const model = builtinModel(env);
    const started = Date.now();
    const meter = builtinMeter(controlPlane, session, model, started);
    const callTool = reflectCallTool(dispatch);
    let ran = null;
    try {
      ran = await runTurn({
        question: reflectQuestion({ question, answer: turn?.answer, steps: turn?.steps, index: learned?.index ?? [], used, reason, today, tainted }),
        tools: reflectTools(offered),
        grants: { write: ["save"] },
        callTool,
        env,
        providerOptions: {
          ai: env.AI,
          gateway: aiGatewayConfig(env),
          metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "reflect" },
        },
        maxRounds: REFLECT_ROUNDS,
        roundCap: REFLECT_ROUNDS,
      });
    } catch (error) {
      await meter(null, true, error instanceof ProviderError ? error.model : model);
      log(session, { outcome: "failed", reason, code: error instanceof ProviderError ? "provider" : "error" });
      return;
    }
    await meter(ran.usage, false, ran.model);
    const outcome = callTool.wrote() ? "wrote" : ran.exhausted ? "exhausted" : "none";
    log(session, { outcome, reason, tainted, steps: ran.steps.length });
  } catch (error) {
    log(session ?? {}, { outcome: "failed", code: error?.name === "TypeError" ? "type" : "error" });
  }
}
