/**
 * Door node "doorStep" (`texConfig.json`, group "intake"): a text's turn, gathered in code before any model runs
 * (`../door.js`), each part logged inside this step's row (`log.parts`, which the runner logs and never hands on). A part that settles the text itself (a yes or a
 * thumbs-up to something Tex is waiting on, a refusal) leaves its answer in `t.response` and tags the output
 * `answered`, which the wire to Confirmations & refusals (`bypass`) fires on; otherwise it tags it `next`, which the wire
 * to the Front door fires on, handing it what the last part found.
 */
import { runDoor } from "../door.js";
import { startRoute } from "../../doorTools.js";

export async function doorStepNode(_input, io) {
  const t = io.ctx.turn;
  const door = await runDoor(t, io.ctx, undefined, undefined, { afterRead: () => { t.shapeRead = shapeBeside(t, io); t.routeRead = routeBeside(t, io); } });
  if (door.answer !== undefined) t.response = door.answer;
  return doorOutput(door);
}

/**
 * The Shape gate, started beside the rest of the door for a text a person sent that the Front door will answer
 * (`../../shapeGate.js`): a promise of its read, or null when this turn has no such text, the config has no wire to
 * the gate, or the gate is off (the runner answers nothing for an off step). Never throws and never rejects: a gate
 * that could not run is a turn without one.
 */
export function shapeBeside(t, io) {
  const texted = t.chatTurn === true && t.job === null && t.report === null && t.routine === null && !t.runner && !t.crossChat && typeof t.question === "string" && t.question.trim() !== "";
  if (!texted) return null;
  try {
    return Promise.resolve(io.use.shapeGate({ question: t.question, group: t.group !== null }))
      .then((read) => (read?.to === "read" ? read : null))
      .catch(() => null);
  } catch {
    return null;
  }
}

/**
 * The router, started beside the Shape gate for the same texts (`../../doorTools.js` `startRoute`): a promise of
 * `{ route, sure, ms }`, or null when this turn has no such text, the config has no wire to the router or it is off. It waits for
 * the Shape gate's read first, so the router is told what the gate found; a gate that failed is a router with none.
 */
export function routeBeside(t, io) {
  const texted = t.chatTurn === true && t.job === null && t.report === null && t.routine === null && !t.runner && !t.crossChat && typeof t.question === "string" && t.question.trim() !== "";
  if (!texted) return null;
  let router;
  try {
    router = io.use.router; // throws when the config has no wire to the router: a turn without one
  } catch {
    return null;
  }
  // An off router answers nothing, so the turn must not wait on the Shape gate for it.
  if (typeof io.on === "function" && !io.on("router")) return null;
  return startRoute(async () => {
    // The recent lines are waited on beside the Shape gate, never after it, and for at most `RECENT_WAIT_MS`.
    const [read, recent] = await Promise.all([t.shapeRead ? t.shapeRead : null, recentOf(t)]);
    const shape = read ? { ending: read.ending, endingSure: read.endingSure, order: read.order, records: read.records } : null;
    return router({ question: t.question, group: t.group !== null, trigger: "text", ...(shape ? { shape } : {}), recent });
  });
}

/** How long the router waits on the turn's history read for its recent lines before it goes without them. */
const RECENT_WAIT_MS = 400;
/** How many of the chat's last lines the router is given (`specialistRoute.js` keeps as many). */
const RECENT_LINES = 8;

/**
 * The chat's last lines before this text, oldest first, as `{ who, text }`, from the history read the door started
 * (`checkItMayRun.js` `historyRead`); none when it isn't read within `RECENT_WAIT_MS` or failed. Never rejects.
 */
export async function recentOf(t, waitMs = RECENT_WAIT_MS) {
  if (!t?.historyRead || typeof t.historyRead.then !== "function") return [];
  let timer;
  const read = await Promise.race([
    Promise.resolve(t.historyRead).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  const history = Array.isArray(read) ? read[0]?.history : read?.history;
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => typeof turn?.text === "string" && turn.text.trim() !== "")
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .slice(-RECENT_LINES)
    .map((turn) => ({ who: turn.role === "assistant" ? "Tex" : "Them", text: turn.text }));
}

/** The step's output for what the door did: tagged for the step it goes to, its parts under `log`, never handed on. */
export function doorOutput({ answer, answeredBy, parts, handed }) {
  if (answer !== undefined) return { when: ["answered"], answeredBy, status: answer?.status, log: { parts } };
  return { when: ["next"], ...handed, log: { parts } };
}
