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
 * `{ route, sure, ms }`, or null when this turn has no such text, the config has no wire to the router or it is off, or
 * it is not back within `ROUTE_WAIT_MS`. It waits for the Shape gate's read first, so the router is told what the gate
 * found; a gate that failed is a router with none. What else it reads is its own config context (`router.js`).
 */
export function routeBeside(t, io, waitMs = ROUTE_WAIT_MS) {
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
  // The whole read, the router's context modules and Clef's answer included, is capped at `ROUTE_WAIT_MS`: a router not
  // back by then is no route, and the turn goes through today's front door (`doorTurn.js`), so it never holds the reply.
  return withinRouteWait(
    startRoute(async () => {
      const read = t.shapeRead ? await t.shapeRead : null;
      const shape = read ? { ending: read.ending, endingSure: read.endingSure, order: read.order, records: read.records } : null;
      return router({ question: t.question, group: t.group !== null, trigger: "text", ...(shape ? { shape } : {}) });
    }),
    waitMs,
  );
}

/** The longest a turn waits on the router, from its start beside the Door; past it the turn is not routed. */
export const ROUTE_WAIT_MS = 1_500;

/** `route` (a promise of the router's read, never rejecting) or null once `ms` have gone by. */
export function withinRouteWait(route, ms = ROUTE_WAIT_MS) {
  let timer;
  return Promise.race([
    route,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The step's output for what the door did: tagged for the step it goes to, its parts under `log`, never handed on. */
export function doorOutput({ answer, answeredBy, parts, handed }) {
  if (answer !== undefined) return { when: ["answered"], answeredBy, status: answer?.status, log: { parts } };
  return { when: ["next"], ...handed, log: { parts } };
}
