/**
 * THE TURN THROUGH A SPECIALIST DOOR, OR THROUGH TODAY'S FRONT DOOR (`graph/nodes/router.js`, `doorTools.js`).
 *
 * The router picked a route for the text (Clef, beside the Door). `runWithDoors` runs the turn through the door the
 * route names, or through the Front door as it always ran:
 *
 * - no route, a route not sure enough (`ROUTE_AT`), no door wired: the Front door, as before. Record `door: "fd"`.
 * - job, sure, and the config wires `router -> handoff`: the job goes to the Hand-off node before any round
 *   (`startWith`); the turn ends on its start line. Otherwise the Front door.
 * - quick, read, act, sure, and the door wired: the specialist runs with the door's tools only (`narrowForDoor`), and
 *   a call outside them ends its run before it runs (`outside`). Then the Front door runs the turn from scratch and
 *   the specialist's spend is added to the turn's, so a misroute costs a retry and never a wrong action. The act door
 *   holds every tool, so its run is the Front door's own chain, and it never hands over.
 *
 * Never throws because of the router or a door: a quick or read door that fails goes to the Front door.
 */
import { DOORS, ROUTE_AT, narrowForDoor, outsideFor } from "./doorTools.js";
import { sixToolsOver } from "./sixTools.js";

/** Two usage records summed, field by field (a missing field is 0). */
const sumNumbers = (into = {}, add = {}) => {
  const out = { ...into };
  for (const [key, value] of Object.entries(add ?? {})) if (typeof value === "number") out[key] = (out[key] ?? 0) + value;
  return out;
};

/** The turn with a specialist's spend added: its usage and its usage by model, so the meter bills both runs. */
export function addSpend(turn, specialist) {
  const usageByModel = { ...(turn.usageByModel ?? {}) };
  for (const [model, usage] of Object.entries(specialist?.usageByModel ?? {})) usageByModel[model] = sumNumbers(usageByModel[model], usage);
  return { ...turn, usage: sumNumbers(turn.usage, specialist?.usage), usageByModel };
}

/**
 * The turn, through its door. `args` is the turn's runTurn options as the Front door builds them; `eligible` says whether
 * this turn may use a door at all; `route` is the router's `{ route, sure, ms }` or null; `via.door(route, input)`
 * answers the door node's output, or null when the door is not wired; `handOffRoute` is `() => line|null` for a job, or
 * null; `doorNotes(door)` is the door's prompt, or null to keep the Front door's.
 *
 * Returns the turn, with `turn.route` set when the router read the text: `{ pick, sure, door, fellBack, routerMs, waitedMs }`.
 */
export async function runWithDoors({ runTurn, args, eligible = false, route = null, waitedMs = null, via = null, handOffRoute = null, doorNotes = () => null }) {
  const pick = typeof route?.route === "string" ? route.route : null;
  const sure = typeof route?.sure === "number" ? route.sure : null;
  // With no router read at all (the router off or unwired), the turn is the front door's as it always was: nothing is recorded.
  const record = (turn, door, fellBack = null) => {
    if (pick !== null) turn.route = { pick, sure, door, fellBack, routerMs: typeof route?.ms === "number" ? route.ms : null, waitedMs };
    return turn;
  };
  const frontDoor = async () => record(await runTurn(args), "fd");
  if (!eligible || pick === null || sure === null || sure < ROUTE_AT) return frontDoor();
  if (pick === "job") {
    if (typeof handOffRoute !== "function") return frontDoor();
    const turn = await runTurn({ ...args, startWith: handOffRoute });
    return record(turn, turn.handedOff === "route" ? "job" : "fd");
  }
  if (!DOORS.includes(pick)) return frontDoor();
  const spec = await Promise.resolve()
    .then(() => via?.door?.(pick, { route: pick, sure }))
    .catch(() => null);
  if (spec?.door !== pick) return frontDoor();

  const act = pick === "act";
  const tools = args.tools ?? [];
  const local = args.local ?? [];
  const narrowed = narrowForDoor(pick, { tools, local, web: args.web ?? null });
  const everything = [...tools, ...(args.web?.tools ?? []), ...local.map((entry) => entry.tool)];
  let specialist;
  try {
    specialist = await runTurn({
      ...args,
      tools: narrowed.tools,
      local: narrowed.local,
      web: narrowed.web,
      outside: outsideFor(pick, sixToolsOver(everything, null), narrowed.allowed),
      notes: doorNotes(pick) ?? args.notes,
      // A quick or read run keeps no rounds and hands nothing over: the front door that may follow must find none of them.
      resumeFrom: null,
      keepRounds: act ? args.keepRounds ?? null : null,
      roundsOut: act ? args.roundsOut ?? null : null,
    });
  } catch (error) {
    // The act door is the front door's own chain: its failure is the front door's failure, as it always was.
    if (act) throw error;
    specialist = { outside: `the ${pick} door failed` };
  }
  if (typeof specialist.outside !== "string") return record(specialist, pick);
  const full = await runTurn(args);
  return record(addSpend(full, specialist), "fd", specialist.outside);
}
